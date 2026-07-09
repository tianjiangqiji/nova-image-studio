'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { hasAnyApiKey } from '@/lib/settings-storage';
import { generateUUID } from '@/lib/uuid';
import { createNovaTask, getNovaTask, resolveImageTaskProvider, type ImageReference } from '@/lib/ccode-task-client';
import { fetchImageAsBlob } from '@/lib/image-downloader';
import {
  getGptImageAdvancedParamsForModel,
  resolveAgentModel,
  type AgentModelCatalogEntry,
  type AgentResolvedLayout,
} from '@/lib/model-capabilities';
import type { ModelId } from '@/lib/gemini-config';
import { getCompleteImageModels, loadRegistry } from '@/lib/nova-models';
import {
  streamAgentChat,
  describeImage,
  type StreamAgentHandle,
} from '@/lib/agent-chat-client';
import {
  AGENT_DEFAULT_IMAGE_MODEL_FALLBACK,
  type AgentMessage,
  type AgentImageRecord,
  type AgentProposal,
} from '@/lib/agent-chat-config';
import {
  loadAgentSession,
  putMessage,
  putImageRecord,
  saveImageModel,
  clearAgentSession,
  storeAgentImageBytes,
  getAgentImageBase64,
  deleteMessages,
  deleteImageRecords,
  deleteAgentImageBytes,
  savePendingProposal,
  loadPendingProposal,
  clearPendingProposal,
  savePendingGeneration,
  loadPendingGeneration,
  clearPendingGeneration,
  type PendingGenerationData,
} from '@/lib/agent-context-store';
import { getDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { supportsAgentNativeWebSearch } from '@/lib/nova-text-protocol';

export type AgentPhase = 'idle' | 'loading' | 'describing' | 'streaming' | 'proposal' | 'generating';

export type AgentCheckResult = 'idle' | 'completed' | 'processing' | 'queued' | 'failed' | 'error';

export interface AgentGenerationDraft {
  analysis: string;
  reasoning?: string;
  prompt: string;
  parallelCount: number;
  taskId?: string;
  startedAt: number;
}

export interface PendingUpload {
  id: string;
  name: string;
  preview: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
  source?: AgentImageRecord['source'];
}

const PREVIEW_MAX_SIDE = 512;

/** 构建当前可用的图像模型目录，供 Agent 选择模型 */
function buildModelCatalog(): AgentModelCatalogEntry[] {
  return getCompleteImageModels(loadRegistry()).map(m => ({
    id: m.id,
    name: m.name,
    maxOutputSize: m.maxOutputSize,
  }));
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}


/** 从 Blob 直接生成缩略图 dataUrl，避免全尺寸 base64 转换 */
async function makePreviewFromBlob(blob: Blob): Promise<{ dataUrl: string; width: number; height: number }> {
  try {
    const blobUrl = URL.createObjectURL(blob);
    const img = await loadImage(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w <= PREVIEW_MAX_SIDE && h <= PREVIEW_MAX_SIDE) {
      // 小图直接转 dataUrl（尺寸小，不影响性能）
      const smallDataUrl = await blobToDataUrl(blob);
      return { dataUrl: smallDataUrl, width: w, height: h };
    }
    const scale = PREVIEW_MAX_SIDE / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = await blobToDataUrl(blob);
      return { dataUrl: fallback, width: w, height: h };
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h };
  } catch {
    const fallback = await blobToDataUrl(blob);
    return { dataUrl: fallback, width: 0, height: 0 };
  }
}

function parseImgSeq(imgId: string): number {
  const match = imgId.match(/^img_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/**
 * 按最后一个上下文分隔点切片：分隔点之前的对话和图片对模型不可见。
 * 界面仍展示全部消息，这里只影响喂给模型的上下文。
 */
function sliceActiveContext(
  history: AgentMessage[],
  catalog: AgentImageRecord[],
): { history: AgentMessage[]; catalog: AgentImageRecord[] } {
  let dividerIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'context-divider') { dividerIndex = i; break; }
  }
  if (dividerIndex === -1) return { history, catalog };

  const dividerAt = history[dividerIndex].createdAt;
  return {
    history: history.slice(dividerIndex + 1),
    catalog: catalog.filter(img => img.createdAt > dividerAt),
  };
}

async function resultImageToBlob(ref: string): Promise<Blob> {
  if (ref.startsWith('URL:')) return fetchImageAsBlob(ref.slice(4));
  if (ref.startsWith('MULTI_URL:')) return fetchImageAsBlob(ref.slice(10).split('|||')[0]);
  if (ref.startsWith('data:')) {
    const base64 = ref.split(',')[1] || '';
    const mime = ref.slice(5).split(';')[0] || 'image/png';
    return base64ToBlob(base64, mime);
  }
  return base64ToBlob(ref, 'image/png');
}

export function useAgentChat() {
  const [ready, setReady] = useState(false);
  const [hasApiKey] = useState(() => hasAnyApiKey());
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [images, setImages] = useState<AgentImageRecord[]>([]);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [imageModel, setImageModelState] = useState<ModelId>(AGENT_DEFAULT_IMAGE_MODEL_FALLBACK);
  const [error, setError] = useState<string | null>(null);
  const [generatingTaskId, setGeneratingTaskId] = useState<string | null>(null);
  const [generatingStartedAt, setGeneratingStartedAt] = useState<number | null>(null);
  const [generationDraft, setGenerationDraft] = useState<AgentGenerationDraft | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('nova-agent-web-search') === 'true' : false
  );
  const [intentRecognition, setIntentRecognition] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('nova-agent-intent-recognition') !== 'false' : true
  );

  const streamHandleRef = useRef<StreamAgentHandle | null>(null);
  const mountedRef = useRef(true);
  const pollAbortRef = useRef(false);
  const pollWakeRef = useRef<(() => void) | null>(null);
  const describeAbortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  /** 当模型返回提案时，暂存分析文本，等生图完成后与结果合并为一条消息 */
  const pendingAnalysisRef = useRef('');
  const pendingReasoningRef = useRef('');
  /** 标记当前提案是否来自"重新编辑"（而非新消息触发），用于取消时决定是否允许撤回 */
  const isReeditRef = useRef(false);
  /** 保存当前提案引用，生图完成后若 state proposal 已被清除时仍可获取 reason 等字段 */
  const proposalRef = useRef<AgentProposal | null>(null);
  /** 镜像 imageModel state，供 runChat 回调中同步读取 */
  const imageModelRef = useRef(imageModel);
  useEffect(() => { imageModelRef.current = imageModel; }, [imageModel]);

  const getAgentTextModelConfig = useCallback(() => {
    const configured = getDefaultConfiguredTextModel('agent');
    if (!configured?.apiKey || !configured.baseUrl || !configured.modelId) {
      throw new Error('请先在设置中完成 Agent 默认文本模型配置');
    }
    return configured;
  }, []);

  const agentSupportsWebSearch = useCallback(() => {
    const configured = getAgentTextModelConfig();
    return supportsAgentNativeWebSearch(configured.protocol);
  }, [getAgentTextModelConfig]);

  // ===== 流式更新批处理（rAF 节流） =====
  const streamingTextBufRef = useRef('');
  const streamingReasoningBufRef = useRef('');
  const rafIdRef = useRef<number | null>(null);

  /** 刷新流式文本到 state（每帧调用一次） */
  const flushStreamingBuffers = useCallback(() => {
    rafIdRef.current = null;
    const text = streamingTextBufRef.current;
    const reasoning = streamingReasoningBufRef.current;
    if (text) { streamingTextBufRef.current = ''; setStreamingText(prev => prev + text); }
    if (reasoning) { streamingReasoningBufRef.current = ''; setStreamingReasoning(prev => prev + reasoning); }
  }, []);

  /** 将 token 追加到缓冲区，并调度下一帧刷新 */
  const appendStreamingToken = useCallback((type: 'text' | 'reasoning', token: string) => {
    if (type === 'text') streamingTextBufRef.current += token;
    else streamingReasoningBufRef.current += token;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushStreamingBuffers);
    }
  }, [flushStreamingBuffers]);

  /** 立即刷新并取消待处理的 rAF（在 onDone/onReset/清理时调用） */
  const flushAndCancelRaf = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const text = streamingTextBufRef.current;
    const reasoning = streamingReasoningBufRef.current;
    streamingTextBufRef.current = '';
    streamingReasoningBufRef.current = '';
    if (text) setStreamingText(prev => prev + text);
    if (reasoning) setStreamingReasoning(prev => prev + reasoning);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [session, pending, generation] = await Promise.all([
        loadAgentSession(),
        loadPendingProposal(),
        loadPendingGeneration(),
      ]);
      if (cancelled) return;
      setMessages(session.messages);
      setImages(session.images);
      seqRef.current = session.images.reduce((max, img) => Math.max(max, parseImgSeq(img.imgId)), 0);
      if (session.imageModel) setImageModelState(session.imageModel as ModelId);

      if (pending) {
        // 恢复待确认的提案，使用户刷新后仍可看到「等待你确认」卡片
        pendingAnalysisRef.current = pending.pendingAnalysis;
        pendingReasoningRef.current = pending.pendingReasoning;
        isReeditRef.current = pending.isReedit;
        setProposal(pending.proposal);
        setPhase('proposal');
      }

      if (generation) {
        // 恢复正在生图的状态：还原 taskId 和 refs，继续轮询结果
        pendingAnalysisRef.current = generation.pendingAnalysis;
        pendingReasoningRef.current = generation.pendingReasoning;
        proposalRef.current = generation.proposal;
        setGeneratingTaskId(generation.taskId);
        setGeneratingStartedAt(generation.startedAt);
        setGenerationDraft({
          analysis: generation.pendingAnalysis || generation.proposal.reason || '根据你的描述，正在生成图片。',
          reasoning: generation.pendingReasoning || undefined,
          prompt: generation.proposal.prompt,
          parallelCount: generation.parallelCount,
          taskId: generation.taskId,
          startedAt: generation.startedAt,
        });
        setPhase('generating');
        // 恢复轮询，cancelled 标记确保组件卸载时丢弃结果
        void resumeGeneration(generation).catch(() => {});
      }

      setReady(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appendMessage = useCallback((message: AgentMessage) => {
    setMessages(prev => [...prev, message]);
    void putMessage(message);
  }, []);

  const registerImage = useCallback((record: AgentImageRecord) => {
    setImages(prev => [...prev, record]);
    void putImageRecord(record);
  }, []);

  const nextImgId = useCallback(() => {
    seqRef.current += 1;
    return `img_${seqRef.current}`;
  }, []);

  // 给一张图片建立登记：存字节 + 生成预览 + 视觉描述
  const ingestImage = useCallback(async (
    source: AgentImageRecord['source'],
    blob: Blob,
    previewDataUrl: string,
    mimeType: string,
    sourceTaskId?: string,
    dims?: { width: number; height: number },
    contentHash?: string,
    describeSignal?: AbortSignal,
  ): Promise<AgentImageRecord> => {
    const imgId = nextImgId();
    // 上传图片（有 contentHash）已在 prepareUploadImage 时存于 nova-upload-cache，
    // 不再重复存到 nova-image-db，节省空间；生成图片无 contentHash 则照常存储。
    if (source === 'generated' || !contentHash) {
      await storeAgentImageBytes(imgId, blob);
    }

    let description = '';
    try {
      const configured = getAgentTextModelConfig();
      description = await describeImage(
        configured.apiKey,
        configured.modelId,
        configured.protocol,
        previewDataUrl,
        describeSignal,
        configured.baseUrl,
      );
    } catch {
      description = '(图片描述生成失败)';
    }

    const record: AgentImageRecord = {
      imgId,
      source,
      thumbnail: previewDataUrl,
      description: description || '(无描述)',
      mimeType,
      contentHash,
      sourceTaskId,
      width: dims?.width && dims.width > 0 ? dims.width : undefined,
      height: dims?.height && dims.height > 0 ? dims.height : undefined,
      createdAt: Date.now(),
    };
    registerImage(record);
    return record;
  }, [nextImgId, registerImage]);

  /** 重新生成已有图片的描述 */
  const redescribeImage = useCallback(async (imgId: string): Promise<string> => {
    const record = images.find(img => img.imgId === imgId);
    if (!record) throw new Error(`图片 ${imgId} 不存在`);
    const configured = getAgentTextModelConfig();
    const newDescription = await describeImage(
      configured.apiKey,
      configured.modelId,
      configured.protocol,
      record.thumbnail,
      undefined,
      configured.baseUrl,
    );
    const description = newDescription || '(无描述)';
    const updated: AgentImageRecord = { ...record, description };
    setImages(prev => prev.map(img => img.imgId === imgId ? updated : img));
    void putImageRecord(updated);
    return description;
  }, [getAgentTextModelConfig, images]);

  const runChat = useCallback((history: AgentMessage[], catalog: AgentImageRecord[]) => {
    const configured = getAgentTextModelConfig();
    const modelCatalog = buildModelCatalog();
    setPhase('streaming');
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');

    let reasoningBuf = '';

    const handle = streamAgentChat(
      {
        apiKey: configured.apiKey,
        model: configured.modelId,
        protocol: configured.protocol,
        history,
        webSearch: webSearchEnabled && supportsAgentNativeWebSearch(configured.protocol),
        catalog: catalog.map(img => ({ imgId: img.imgId, description: img.description })),
        modelCatalog,
      },
      {
        onDelta: token => appendStreamingToken('text', token),
        onReasoning: token => {
          reasoningBuf += token;
          appendStreamingToken('reasoning', token);
        },
        onResetAttempt: () => {
          reasoningBuf = '';
          flushAndCancelRaf();
          setStreamingText('');
          setStreamingReasoning('');
        },
        onDone: (fullText, parsedProposal) => {
          streamHandleRef.current = null;
          flushAndCancelRaf();
          setStreamingText('');
          setStreamingReasoning('');
          const text = fullText.trim();
          const reasoning = reasoningBuf.trim();
          if (parsedProposal) {
            // 模型自动选择：Agent 指定模型 id 或用户要求分辨率档位时自动切换
            const resolvedModel = resolveAgentModel(
              imageModelRef.current,
              parsedProposal.requestedModelId,
              parsedProposal.requestedOutputSize,
              modelCatalog,
            );
            if (resolvedModel !== imageModelRef.current) {
              imageModelRef.current = resolvedModel;
              setImageModelState(resolvedModel);
              void saveImageModel(resolvedModel);
            }
            // 有提案：不保存为单独消息，暂存分析文本供生图成功后合并
            pendingAnalysisRef.current = text;
            pendingReasoningRef.current = reasoning;
            isReeditRef.current = false;
            setProposal(parsedProposal);
            setPhase('proposal');
            // 持久化 pending proposal，刷新页面后可以恢复
            void savePendingProposal({
              proposal: parsedProposal,
              pendingAnalysis: text,
              pendingReasoning: reasoning,
              isReedit: false,
            });
          } else {
            // 纯文本回复：正常保存为消息
            if (text.length > 0) {
              appendMessage({
                id: generateUUID(),
                role: 'assistant',
                text,
                reasoning: reasoning.length > 0 ? reasoning : undefined,
                createdAt: Date.now(),
              });
            }
            setPhase('idle');
          }
        },
        onError: err => {
          streamHandleRef.current = null;
          flushAndCancelRaf();
          setStreamingText('');
          setStreamingReasoning('');
          setError(err.message);
          setPhase('idle');
        },
      },
      configured.baseUrl,
    );
    streamHandleRef.current = handle;
  }, [appendMessage, appendStreamingToken, flushAndCancelRaf, getAgentTextModelConfig, webSearchEnabled]);

  const sendMessage = useCallback(async (text: string, uploads: PendingUpload[], imageReferences?: string[]) => {
    if (phase !== 'idle') return;
    const trimmed = text.trim();
    if (trimmed.length === 0 && uploads.length === 0) return;
    setError(null);
    // 用户发送新消息时，丢弃任何待定提案的分析文本
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    isReeditRef.current = false;
    void clearPendingProposal();

    const uploadedRecords: AgentImageRecord[] = [];
    const linkedIds: string[] = [];
    if (uploads.length > 0) {
      const descController = new AbortController();
      describeAbortRef.current = descController;

      setPhase('describing');
      const seenHashes = new Set<string>();
      try {
        for (const upload of uploads) {
        const hash = upload.id;
        // 同批内重复 + 历史已登记重复，统一按内容哈希复用，不重复登记
        if (hash && seenHashes.has(hash)) continue;
        const existing = hash
          ? [...images, ...uploadedRecords].find(img => img.contentHash === hash)
          : undefined;
        if (existing) {
          if (hash) seenHashes.add(hash);
          if (!linkedIds.includes(existing.imgId)) linkedIds.push(existing.imgId);
          continue;
        }
        try {
          const blob = await resultImageToBlob(upload.dataUrl);
          const preview = await makePreviewFromBlob(blob);
          const record = await ingestImage(upload.source || 'uploaded', blob, preview.dataUrl, upload.mimeType, undefined, { width: preview.width, height: preview.height }, hash || undefined, descController.signal);
          uploadedRecords.push(record);
          if (hash) seenHashes.add(hash);
          linkedIds.push(record.imgId);
        } catch (err) {
          setError(err instanceof Error ? err.message : '图片处理失败');
        }
        }
      } finally {
        if (describeAbortRef.current === descController) {
          describeAbortRef.current = null;
        }
      }
    }

    const uploadedIds = linkedIds;
    const refSuffix = imageReferences && imageReferences.length > 0
      ? `\n[引用图片: ${imageReferences.join(', ')}]`
      : '';
    const noteSuffix = uploadedIds.length > 0 ? `\n[已上传图片: ${uploadedIds.join(', ')}]` : '';
    const userMessage: AgentMessage = {
      id: generateUUID(),
      role: 'user',
      text: `${trimmed}${refSuffix}${noteSuffix}`.trim(),
      imageIds: uploadedIds.length > 0 ? uploadedIds : undefined,
      createdAt: Date.now(),
    };
    appendMessage(userMessage);

    const fullHistory = [...messages, userMessage];
    const fullCatalog = [...images, ...uploadedRecords];
    const { history, catalog } = sliceActiveContext(fullHistory, fullCatalog);
    runChat(history, catalog);
  }, [phase, messages, images, appendMessage, ingestImage, runChat]);

  const cancelProposal = useCallback(() => {
    setProposal(null);
    setPhase('idle');
    // 取消时如果有待定分析，保存为一条助手消息供用户回顾
    const analysis = pendingAnalysisRef.current;
    const analysisReasoning = pendingReasoningRef.current;
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    // 二次编辑取消时不标记为可撤回，防止误操作删除已有图片
    const wasReedit = isReeditRef.current;
    isReeditRef.current = false;
    void clearPendingProposal();
    if (analysis) {
      appendMessage({
        id: generateUUID(),
        role: 'assistant',
        text: analysis,
        reasoning: analysisReasoning || undefined,
        createdAt: Date.now(),
      });
    }
    appendMessage({
      id: generateUUID(),
      role: 'system-note',
      text: wasReedit ? '已取消本次重新编辑。' : '已取消本次生图提案。',
      withdrawable: !wasReedit,
      createdAt: Date.now(),
    });
  }, [appendMessage]);

  // 撤回最后一轮对话：从最后一条用户消息起（含其后的助手回复与本提示）全部删除，避免污染后续上下文
  const withdrawTurn = useCallback((noteId: string) => {
    setMessages(prev => {
      const noteIndex = prev.findIndex(m => m.id === noteId);
      if (noteIndex === -1) return prev;
      let start = noteIndex;
      for (let i = noteIndex - 1; i >= 0; i--) {
        if (prev[i].role === 'user') { start = i; break; }
      }
      const removed = prev.slice(start);
      void deleteMessages(removed.map(m => m.id));
      return prev.slice(0, start);
    });
  }, []);

  const pollTask = useCallback(async (taskId: string) => {
    pollAbortRef.current = false;
    for (;;) {
      if (pollAbortRef.current || !mountedRef.current) throw new Error('已停止');
      const task = await getNovaTask(taskId);
      if (task.status === 'completed') return task;
      if (task.status === 'failed' || task.status === 'expired') {
        throw new Error(task.error || task.warning || '生图任务失败');
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          pollWakeRef.current = null;
          resolve();
        }, 4000);
        // 暴露唤醒钩子：主动查询时立即结束本次等待
        pollWakeRef.current = () => {
          clearTimeout(timer);
          pollWakeRef.current = null;
          resolve();
        };
      });
    }
  }, []);

  /**
   * 生图任务完成后的统一后处理：下载图片 → 缩略图 + 视觉描述 → 登记 →
   * 合并成一条助手消息 → 清理生图状态。approveProposal 与 resumeGeneration
   * 此前各自重复了这段约 100 行逻辑，这里抽成单一实现，差异通过 ctx 注入。
   */
  const processGeneratedTask = useCallback(async (
    allImages: string[],
    ctx: {
      taskId: string;
      prompt: string;
      analysisFallbackReason: string;
      proposalData: AgentMessage['proposalData'];
    },
  ): Promise<void> => {
    const descController = new AbortController();
    describeAbortRef.current = descController;

    // 先下载所有图片
    setPhase('loading');
    const blobs = await Promise.allSettled(allImages.map(ref => resultImageToBlob(ref)));

    // 再生成缩略图 + 视觉描述
    setPhase('describing');
    const records: AgentImageRecord[] = [];
    const errors: string[] = [];
    try {
      for (let i = 0; i < allImages.length; i++) {
        try {
          const settled = blobs[i];
          const blob = settled && settled.status === 'fulfilled' ? settled.value : null;
          if (!blob) { errors.push('图片下载失败'); continue; }
          const preview = await makePreviewFromBlob(blob);
          const record = await ingestImage('generated', blob, preview.dataUrl, blob.type || 'image/png', ctx.taskId, { width: preview.width, height: preview.height }, undefined, descController.signal);
          records.push(record);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      if (describeAbortRef.current === descController) {
        describeAbortRef.current = null;
      }
    }

    if (records.length === 0) {
      throw new Error(errors[0] || '图片处理失败');
    }

    const imgIds = records.map(r => r.imgId);
    const imgList = imgIds.join('、');
    const analysis = pendingAnalysisRef.current || ctx.analysisFallbackReason || '';
    const reasoning = pendingReasoningRef.current;
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    let generatedText = '';
    generatedText += `分析：${analysis || '根据你的描述，已为你生成图片。'}\n`;
    generatedText += `优化提示词：${ctx.prompt}\n`;
    generatedText += `结果：已生成图片 ${imgList}。需要继续调整就告诉我。`;
    if (errors.length > 0) {
      generatedText += `\n（部分图片处理失败：${errors.join('；')}）`;
    }

    appendMessage({
      id: generateUUID(),
      role: 'assistant',
      text: generatedText,
      reasoning: reasoning || undefined,
      imageIds: imgIds,
      taskId: ctx.taskId,
      proposalData: ctx.proposalData,
      createdAt: Date.now(),
    });
    void clearPendingGeneration();
    setGeneratingTaskId(null);
    setGeneratingStartedAt(null);
    setGenerationDraft(null);
    setIsSyncing(false);
    setPhase('idle');
  }, [appendMessage, ingestImage]);

  /** 页面刷新后恢复生图轮询：使用持久化的 generation 数据继续轮询并处理结果 */
  const resumeGeneration = useCallback(async (data: PendingGenerationData) => {
    pollAbortRef.current = false;
    try {
      const task = await pollTask(data.taskId);
      if (!mountedRef.current) return;
      const allImages = task.result?.images;
      if (!allImages || allImages.length === 0) throw new Error('后端未返回图片');

      await processGeneratedTask(allImages, {
        taskId: data.taskId,
        prompt: data.proposal.prompt,
        analysisFallbackReason: data.proposal.reason || '',
        proposalData: {
          action: data.selectedImageIds.length > 0 ? 'edit' : 'generate',
          prompt: data.proposal.prompt,
          referencedImageIds: data.selectedImageIds,
          model: data.model as ModelId,
          outputSize: data.outputSize,
          customSize: data.customSize,
          aspectRatio: data.aspectRatio,
          temperature: data.temperature,
          gptImageQuality: data.gptImageQuality,
          gptImageStyle: data.gptImageStyle,
          gptImageBackground: data.gptImageBackground,
          parallelCount: data.parallelCount,
        },
      });
    } catch (err) {
      void clearPendingGeneration();
      setError(err instanceof Error ? err.message : '生图失败');
      setProposal({
        action: data.proposal?.action ?? (data.selectedImageIds.length > 0 ? 'edit' : 'generate'),
        prompt: data.proposal.prompt,
        referencedImageIds: data.selectedImageIds,
        reason: data.proposal?.reason ?? '',
        requestedAspectRatio: data.proposal?.requestedAspectRatio,
        suggestedAspectRatio: data.proposal?.suggestedAspectRatio ?? data.aspectRatio,
        requestedOutputSize: data.proposal?.requestedOutputSize ?? data.outputSize,
        temperature: data.temperature,
        gptImageQuality: data.gptImageQuality,
        gptImageStyle: data.gptImageStyle,
        gptImageBackground: data.gptImageBackground,
        parallelCount: data.parallelCount,
      });
      setGeneratingTaskId(null);
      setGeneratingStartedAt(null);
      setGenerationDraft(null);
      setIsSyncing(false);
      setPhase('proposal');
    }
  }, [pollTask, processGeneratedTask]);

  const checkNow = useCallback(async (): Promise<AgentCheckResult> => {
    if (phase !== 'generating') return 'idle';
    const taskId = generatingTaskId;
    if (!taskId) return 'idle';

    setIsSyncing(true);
    // 立即唤醒主轮询，让完成/失败的状态切换尽快走正常流程
    pollWakeRef.current?.();

    try {
      const task = await getNovaTask(taskId);
      if (task.status === 'completed') return 'completed';
      if (task.status === 'failed' || task.status === 'expired') return 'failed';
      if (task.status === 'processing') return 'processing';
      return 'queued';
    } catch {
      return 'error';
    } finally {
      setIsSyncing(false);
    }
  }, [phase, generatingTaskId]);

  const approveProposal = useCallback(async (
    finalPrompt: string,
    selectedImageIds: string[],
    model: string,
    params: AgentResolvedLayout,
  ) => {
    if (phase !== 'proposal') return;
    const prompt = finalPrompt.trim();
    if (prompt.length === 0) {
      setError('提示词不能为空');
      return;
    }
    setError(null);
    const startedAt = Date.now();
    const approvedProposal: AgentProposal = {
      action: proposal?.action ?? (selectedImageIds.length > 0 ? 'edit' : 'generate'),
      prompt,
      referencedImageIds: selectedImageIds,
      reason: proposal?.reason ?? '',
      requestedAspectRatio: proposal?.requestedAspectRatio,
      suggestedAspectRatio: proposal?.suggestedAspectRatio ?? params.aspectRatio,
      requestedOutputSize: proposal?.requestedOutputSize ?? params.outputSize,
      temperature: params.temperature,
      gptImageQuality: params.gptImageQuality,
      gptImageStyle: params.gptImageStyle,
      gptImageBackground: params.gptImageBackground,
      parallelCount: params.parallelCount,
      requestedModelId: proposal?.requestedModelId,
    };
    proposalRef.current = approvedProposal;
    setProposal(null);
    void clearPendingProposal();
    setPhase('generating');
    setGeneratingStartedAt(startedAt);
    setGenerationDraft({
      analysis: pendingAnalysisRef.current || approvedProposal.reason || '根据你的描述，正在生成图片。',
      reasoning: pendingReasoningRef.current || undefined,
      prompt,
      parallelCount: params.parallelCount,
      startedAt,
    });

    try {
      const references: ImageReference[] = [];
      for (const imgId of selectedImageIds) {
        const bytes = await getAgentImageBase64(imgId);
        if (bytes) references.push({ data: bytes.data, mimeType: bytes.mimeType });
      }
      const mode = references.length > 0 ? 'image-to-image' : 'text-to-image';
      const provider = resolveImageTaskProvider(model);

      const taskId = await createNovaTask({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        mode,
        prompt,
        outputSize: params.outputSize,
        customSize: params.customSize,
        aspectRatio: params.aspectRatio,
        temperature: params.temperature,
        model: provider.modelId,
        gptImageQuality: params.gptImageQuality,
        gptImageStyle: params.gptImageStyle,
        gptImageBackground: params.gptImageBackground,
        parallelCount: params.parallelCount,
        images: references,
      });
      setGeneratingTaskId(taskId);
      setGenerationDraft(prev => prev ? { ...prev, taskId } : prev);
      void savePendingGeneration({
        taskId,
        proposal: approvedProposal,
        pendingAnalysis: pendingAnalysisRef.current,
        pendingReasoning: pendingReasoningRef.current,
        selectedImageIds,
        model,
        outputSize: params.outputSize,
        customSize: params.customSize,
        aspectRatio: params.aspectRatio,
        temperature: params.temperature,
        gptImageQuality: params.gptImageQuality,
        gptImageStyle: params.gptImageStyle,
        gptImageBackground: params.gptImageBackground,
        parallelCount: params.parallelCount,
        startedAt,
      });

      const task = await pollTask(taskId);
      if (!mountedRef.current) return;
      const allImages = task.result?.images;
      if (!allImages || allImages.length === 0) throw new Error('后端未返回图片');

      await processGeneratedTask(allImages, {
        taskId,
        prompt,
        analysisFallbackReason: proposalRef.current?.reason || '',
        proposalData: {
          action: selectedImageIds.length > 0 ? 'edit' : 'generate',
          prompt,
          referencedImageIds: selectedImageIds,
          model,
          outputSize: params.outputSize,
          customSize: params.customSize,
          aspectRatio: params.aspectRatio,
          temperature: params.temperature,
          gptImageQuality: params.gptImageQuality,
          gptImageStyle: params.gptImageStyle,
          gptImageBackground: params.gptImageBackground,
          parallelCount: params.parallelCount,
        },
      });
    } catch (err) {
      void clearPendingGeneration();
      setError(err instanceof Error ? err.message : '生图失败');
      setProposal({
        action: approvedProposal.action,
        prompt,
        referencedImageIds: selectedImageIds,
        reason: approvedProposal.reason,
        requestedAspectRatio: approvedProposal.requestedAspectRatio,
        suggestedAspectRatio: approvedProposal.suggestedAspectRatio,
        requestedOutputSize: approvedProposal.requestedOutputSize,
        temperature: params.temperature,
        gptImageQuality: params.gptImageQuality,
        gptImageStyle: params.gptImageStyle,
        gptImageBackground: params.gptImageBackground,
        parallelCount: params.parallelCount,
        requestedModelId: approvedProposal.requestedModelId,
      });
      setGeneratingTaskId(null);
      setGeneratingStartedAt(null);
      setGenerationDraft(null);
      setIsSyncing(false);
      setPhase('proposal');
    }
  }, [phase, proposal, pollTask, processGeneratedTask]);

  const stopStreaming = useCallback(() => {
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    pollAbortRef.current = true;
    pollWakeRef.current?.();
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    setGeneratingTaskId(null);
    setGeneratingStartedAt(null);
    setGenerationDraft(null);
    setIsSyncing(false);
    setPhase('idle');
    describeAbortRef.current?.abort();
    void clearPendingProposal();
    void clearPendingGeneration();
  }, [flushAndCancelRaf]);

  const skipDescribing = useCallback(() => {
    describeAbortRef.current?.abort();
    describeAbortRef.current = null;
  }, []);

  const setImageModel = useCallback((model: ModelId) => {
    setImageModelState(model);
    void saveImageModel(model);
  }, []);

  const toggleWebSearch = useCallback(() => {
    if (!agentSupportsWebSearch()) return;
    setWebSearchEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('nova-agent-web-search', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, [agentSupportsWebSearch]);

  const toggleIntentRecognition = useCallback(() => {
    setIntentRecognition(prev => {
      const next = !prev;
      try { localStorage.setItem('nova-agent-intent-recognition', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // 清理上下文：插入一个分隔点，分隔点之前的对话与图片对模型不再可见，但界面保留可见。
  const clearContext = useCallback(() => {
    if (phase !== 'idle') return;
    setMessages(prev => {
      const lastReal = [...prev].reverse().find(m => m.role !== 'context-divider');
      if (!lastReal) return prev;
      if (prev[prev.length - 1]?.role === 'context-divider') return prev;
      const divider: AgentMessage = {
        id: generateUUID(),
        role: 'context-divider',
        text: '以下为新对话，助手已不记得上文',
        createdAt: Date.now(),
      };
      void putMessage(divider);
      return [...prev, divider];
    });
    setProposal(null);
    setError(null);
  }, [phase]);

  const clearSession = useCallback(async () => {
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    pollAbortRef.current = true;
    pollWakeRef.current?.();
    describeAbortRef.current?.abort();
    await clearAgentSession();
    setMessages([]);
    setImages([]);
    setProposal(null);
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    setGeneratingTaskId(null);
    setGeneratingStartedAt(null);
    setGenerationDraft(null);
    setIsSyncing(false);
    setError(null);
    seqRef.current = 0;
    setPhase('idle');
  }, [flushAndCancelRaf]);

  /** 根据消息中的 proposalData 重新打开提案编辑 */
  const reeditProposal = useCallback((messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (!message?.proposalData) return;
    const pd = message.proposalData;
    const advancedParams = getGptImageAdvancedParamsForModel(pd.model, {
      quality: pd.gptImageQuality,
      style: pd.gptImageStyle,
      background: pd.gptImageBackground,
    });
    // 构建 AgentProposal 重新进入 proposal 阶段
    const newProposal: AgentProposal = {
      action: pd.action,
      prompt: pd.prompt,
      referencedImageIds: pd.referencedImageIds,
      reason: '重新编辑之前的生图请求。',
      requestedAspectRatio: undefined,
      suggestedAspectRatio: pd.aspectRatio,
      requestedOutputSize: pd.outputSize,
      temperature: pd.temperature,
      gptImageQuality: advancedParams.quality,
      gptImageStyle: advancedParams.style,
      gptImageBackground: advancedParams.background,
      parallelCount: pd.parallelCount,
      requestedModelId: pd.model,
    };
    // 重新编辑时恢复原始生图模型
    const reeditCatalog = buildModelCatalog();
    const resolvedModel = resolveAgentModel(
      imageModelRef.current,
      newProposal.requestedModelId,
      newProposal.requestedOutputSize,
      reeditCatalog,
    );
    if (resolvedModel !== imageModelRef.current) {
      imageModelRef.current = resolvedModel;
      setImageModelState(resolvedModel);
      void saveImageModel(resolvedModel);
    }
    // 清除上次待定分析，因为用户要重新编辑
    pendingAnalysisRef.current = '';
    pendingReasoningRef.current = '';
    isReeditRef.current = true;
    setProposal(newProposal);
    setPhase('proposal');
    void savePendingProposal({
      proposal: newProposal,
      pendingAnalysis: '',
      pendingReasoning: '',
      isReedit: true,
    });
  }, [messages]);

  /** 清理指定消息引用的且不再被其他消息使用的图片 */
  const cleanupOrphanImages = useCallback((keptMessages: AgentMessage[], removedImageIds: string[]) => {
    const uniqueIds = [...new Set(removedImageIds)];
    for (const imgId of uniqueIds) {
      const stillReferenced = keptMessages.some(m => m.imageIds?.includes(imgId));
      if (!stillReferenced) {
        setImages(prev => prev.filter(img => img.imgId !== imgId));
        void deleteImageRecords([imgId]);
        void deleteAgentImageBytes(imgId);
      }
    }
  }, []);

  /** 删除单条消息（用户或助手），同时清理关联的图片资源 */
  const deleteMessage = useCallback((messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (!message) return;
    const removedImageIds = message.imageIds || [];
    setMessages(prev => prev.filter(m => m.id !== messageId));
    void deleteMessages([messageId]);
    cleanupOrphanImages(messages.filter(m => m.id !== messageId), removedImageIds);
  }, [messages, cleanupOrphanImages]);

  /** 撤回：删除从指定消息开始（含）之后的所有消息，同时清理关联图片 */
  const rollbackMessages = useCallback((fromMessageId: string) => {
    const fromIndex = messages.findIndex(m => m.id === fromMessageId);
    if (fromIndex === -1) return;
    const toRemove = messages.slice(fromIndex);
    const removedImageIds = toRemove.flatMap(m => m.imageIds || []);
    setMessages(prev => prev.slice(0, fromIndex));
    void deleteMessages(toRemove.map(m => m.id));
    cleanupOrphanImages(messages.slice(0, fromIndex), removedImageIds);
    // 如果当前在 proposal 阶段且涉及被删除的上下文，重置
    setProposal(null);
    void clearPendingProposal();
    flushAndCancelRaf();
    setStreamingText('');
    setStreamingReasoning('');
    if (phase !== 'idle') setPhase('idle');
  }, [messages, phase, cleanupOrphanImages, flushAndCancelRaf]);

  // 组件卸载时清理：取消 rAF + 停止轮询/流式/描述，避免卸载后仍每 4s 轮询、
  // 在卸载后继续下载/写库/setState（内存泄漏 + 卸载后写状态）。
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      pollAbortRef.current = true;
      pollWakeRef.current?.();
      streamHandleRef.current?.abort();
      describeAbortRef.current?.abort();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  return {
    ready,
    hasApiKey,
    phase,
    messages,
    images,
    proposal,
    streamingText,
    streamingReasoning,
    imageModel,
    error,
    generatingTaskId,
    generatingStartedAt,
    generationDraft,
    isSyncing,
    webSearchEnabled,
    agentSupportsWebSearch: agentSupportsWebSearch(),
    intentRecognition,
    sendMessage,
    approveProposal,
    cancelProposal,
    reeditProposal,
    withdrawTurn,
    deleteMessage,
    rollbackMessages,
    checkNow,
    stopStreaming,
    skipDescribing,
    setImageModel,
    toggleWebSearch,
    toggleIntentRecognition,
    clearSession,
    clearContext,
    redescribeImage,
    dismissError: () => setError(null),
  };
}
