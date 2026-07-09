'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import type { RefImageData } from '@/lib/job-store';
import { cn } from '@/lib/utils';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import { GifParametersPanel, type GifUploadedRef } from '@/components/gif/GifParametersPanel';
import { GifReviewPanel } from '@/components/gif/GifReviewPanel';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { GifModeChoiceDialog } from '@/components/GifModeChoiceDialog';
import { GifFrameTuner } from '@/components/GifFrameTuner';
import { prepareUploadImage, getOptimizationBadge } from '@/lib/upload-image-cache';
import { extractGridCells, type ExtractedGrid } from '@/lib/gif-encoder';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  getGptImageAdvancedParamsForModel,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
} from '@/lib/model-capabilities';
import {
  GIF_DEFAULT_FRAME_DELAY_MS,
  GIF_DEFAULT_LOOP_COUNT,
  GIF_DEFAULT_FRAME_PADDING,
  GIF_MAX_FRAME_PADDING,
  GIF_MAX_REF_IMAGES,
  getDefaultGifModelId,
  getGifCompatibleModels,
  needsOverwriteConfirm,
  type GifModel,
} from '@/lib/gif-job-store';

import { MAX_UPLOAD_SIZE_BYTES } from '@/lib/constants';
import { useGifWorkflow } from '@/hooks/useGifWorkflow';
import type { ImageActionPayload } from '@/lib/image-actions';
import { getDefaultConfiguredTextModel } from '@/lib/model-endpoints';

interface GifGenerationWorkspaceProps {
  wideMode?: boolean;
  hasApiKey: boolean;
  onConfigureApiKey: () => void;
  onError: (message: string) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
}

const SETTINGS_KEY = 'nova-gif-settings';

interface PersistedSettings {
  model: GifModel;
  loop: boolean;
  frameDelayMs: number;
  loopCount: number;
  closedLoop: boolean;
  framePadding: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
}

export function GifGenerationWorkspace({ wideMode = false, hasApiKey, onConfigureApiKey, onError, showToast }: GifGenerationWorkspaceProps) {
  const workflow = useGifWorkflow();
  const gifModelOptions = useMemo(() => getGifCompatibleModels(), []);

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<GifModel>(getDefaultGifModelId());
  const [gptImageAdvancedParams, setGptImageAdvancedParams] = useState<GptImageAdvancedParams>(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  const [loop, setLoop] = useState(true);
  const [closedLoop, setClosedLoop] = useState(false);
  const [frameDelayMs, setFrameDelayMs] = useState<number>(GIF_DEFAULT_FRAME_DELAY_MS);
  const [loopCount, setLoopCount] = useState<number>(GIF_DEFAULT_LOOP_COUNT);
  const [framePadding, setFramePadding] = useState<number>(GIF_DEFAULT_FRAME_PADDING);
  const [refFiles, setRefFiles] = useState<GifUploadedRef[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);

  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [missingKeyOpen, setMissingKeyOpen] = useState(false);
  const [modeChoiceOpen, setModeChoiceOpen] = useState(false);
  const [extractedGrid, setExtractedGrid] = useState<ExtractedGrid | null>(null);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [refreshCooldownEnd, setRefreshCooldownEnd] = useState(0);
  const [refreshCooldownActive, setRefreshCooldownActive] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  // 提示词优化
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

  const handleOptimize = useCallback(() => {
    const textModel = getDefaultConfiguredTextModel('promptOptimize');
    if (!textModel?.apiKey || !textModel.baseUrl || !textModel.modelId || !prompt.trim()) return;

    optimizeHandleRef.current?.abort();
    setOptimizedText('');
    setOptimizeError(null);
    setOptimizing(true);
    setOptimizeOpen(true);

    const images = refFiles.map(f => ({ dataUrl: f.dataUrl, mimeType: f.mimeType }));
    const handle = streamPromptOptimize(
      { apiKey: textModel.apiKey, model: textModel.id, mode: 'gif', prompt: prompt.trim(), images },
      {
        onDelta(token) { setOptimizedText(prev => prev + token); },
        onDone() { setOptimizing(false); },
        onError(err) { setOptimizeError(err.message); setOptimizing(false); },
      },
      textModel.baseUrl,
    );
    optimizeHandleRef.current = handle;
  }, [prompt, refFiles]);

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText('');
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText) setPrompt(optimizedText);
    optimizeHandleRef.current = null;
    setOptimizedText('');
    setOptimizeError(null);
  }, [optimizedText]);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      const saved = loadJsonFromStorage<PersistedSettings>(SETTINGS_KEY);
      const defaultModel = getDefaultGifModelId();
      const savedModel = saved.model && gifModelOptions.some((option) => option.value === saved.model)
        ? saved.model
        : defaultModel;
      setModel(savedModel);
      setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(savedModel, {
        quality: saved.gptImageQuality,
        style: saved.gptImageStyle,
        background: saved.gptImageBackground,
      }));
      if (typeof saved.loop === 'boolean') {
        setLoop(saved.loop);
      }
      if (typeof saved.closedLoop === 'boolean') {
        setClosedLoop(saved.closedLoop);
      }
      if (typeof saved.frameDelayMs === 'number' && saved.frameDelayMs >= 50 && saved.frameDelayMs <= 1000) {
        setFrameDelayMs(saved.frameDelayMs);
      }
      if (typeof saved.loopCount === 'number' && saved.loopCount >= 0 && saved.loopCount <= 999) {
        setLoopCount(saved.loopCount);
      }
      if (typeof saved.framePadding === 'number' && saved.framePadding >= 0 && saved.framePadding <= GIF_MAX_FRAME_PADDING) {
        setFramePadding(saved.framePadding);
      }
      setSettingsReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [gifModelOptions]);

  useEffect(() => {
    if (!settingsReady) return;
    saveJsonToStorage(SETTINGS_KEY, {
      model,
      loop,
      closedLoop,
      frameDelayMs,
      loopCount,
      framePadding,
      gptImageQuality: gptImageAdvancedParams.quality,
      gptImageStyle: gptImageAdvancedParams.style,
      gptImageBackground: gptImageAdvancedParams.background,
    });
  }, [model, loop, closedLoop, frameDelayMs, loopCount, framePadding, gptImageAdvancedParams, settingsReady]);

  useEffect(() => {
    if (!workflow.startedAt || (workflow.job?.status !== 'generating_grid' && workflow.job?.status !== 'generating_gif')) {
      return;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.floor((Date.now() - (workflow.startedAt || Date.now())) / 1000));
    };

    queueMicrotask(updateElapsed);
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [workflow.startedAt, workflow.job?.status]);

  useEffect(() => {
    if (!refreshCooldownEnd) return;
    const delay = Math.max(0, refreshCooldownEnd - Date.now());
    const timer = window.setTimeout(() => setRefreshCooldownActive(false), delay);
    return () => window.clearTimeout(timer);
  }, [refreshCooldownEnd]);

  const status = workflow.job?.status || 'idle';
  const generating = status === 'generating_grid' || status === 'generating_gif';

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(file => file.type.startsWith('image/'));
    if (files.length === 0) {
      setUploadError('请选择图片文件');
      return;
    }
    if (refFiles.length + files.length > GIF_MAX_REF_IMAGES) {
      setUploadError(`最多上传 ${GIF_MAX_REF_IMAGES} 张参考图`);
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      const accepted: GifUploadedRef[] = [];
      for (const file of files) {
        const optimized = await prepareUploadImage(file);
        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          setUploadError(`文件过大: ${file.name}，压缩后仍超过 10MB`);
          continue;
        }
        accepted.push({
          id: optimized.id,
          name: optimized.name,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          preview: optimized.preview,
          badge: getOptimizationBadge(optimized.originalSize, optimized.processedSize, optimized.cacheHit),
        });
      }
      setRefFiles(prev => {
        const existingIds = new Set(prev.map(f => f.id));
        const uniqueNew = accepted.filter(f => !existingIds.has(f.id));
        return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
      });
    } catch {
      setUploadError('文件读取失败');
    } finally {
      setUploading(false);
    }
  }, [refFiles.length]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    if (hasApiKey && event.dataTransfer.files.length > 0) {
      void processFiles(event.dataTransfer.files);
    }
  }, [hasApiKey, processFiles]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      void processFiles(event.target.files);
      event.target.value = '';
    }
  };

  const handleRemoveRef = useCallback((id: string) => {
    setRefFiles(prev => prev.filter(file => file.id !== id));
  }, []);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (!hasApiKey || uploading) return;
      const target = event.target as HTMLElement;
      // 只处理粘贴目标在本表单容器内的事件，避免与其他全局粘贴处理器冲突
      if (!dropRef.current?.contains(target)) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      const images: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) images.push(file);
        }
      }
      if (images.length > 0) {
        event.preventDefault();
        void processFiles(images);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [hasApiKey, uploading, processFiles]);

  const handleModelChange = useCallback((value: GifModel) => {
    setModel(value);
    setGptImageAdvancedParams(prev => getGptImageAdvancedParamsForModel(value, prev));
  }, []);

  const submitInput = useMemo(() => ({
    prompt,
    loop,
    closedLoop,
    model,
    gptImageQuality: gptImageAdvancedParams.quality,
    gptImageStyle: gptImageAdvancedParams.style,
    gptImageBackground: gptImageAdvancedParams.background,
    refImages: refFiles.map<RefImageData>(file => ({
      id: file.id,
      name: file.name,
      dataUrl: file.dataUrl,
      mimeType: file.mimeType,
    })),
    frameDelayMs,
    loopCount,
    framePadding,
  }), [prompt, loop, closedLoop, model, gptImageAdvancedParams, refFiles, frameDelayMs, loopCount, framePadding]);

  const performSubmit = useCallback(async () => {
    if (!hasApiKey) {
      setMissingKeyOpen(true);
      return;
    }
    try {
      await workflow.submitGrid(submitInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : '提交失败';
      if (message === '请先配置 API 密钥') {
        setMissingKeyOpen(true);
      } else {
        onError(message);
      }
    }
  }, [hasApiKey, onError, submitInput, workflow]);

  const handleSubmitClick = useCallback(() => {
    if (!prompt.trim()) return;
    if (needsOverwriteConfirm(workflow.job)) {
      setOverwriteOpen(true);
      return;
    }
    void performSubmit();
  }, [performSubmit, prompt, workflow.job]);

  const handleResetClick = useCallback(() => {
    if (!workflow.job) return;
    setResetOpen(true);
  }, [workflow.job]);

  const handleEncodeGif = useCallback(() => {
    setModeChoiceOpen(true);
  }, []);

  const handleAutoGenerate = useCallback(() => {
    setModeChoiceOpen(false);
    void workflow.encodeGif({
      loop,
      frameDelayMs,
      loopCount,
      framePadding,
    });
  }, [workflow, loop, frameDelayMs, loopCount, framePadding]);

  const handleTuneGenerate = useCallback(async () => {
    setModeChoiceOpen(false);
    if (!workflow.gridImageUrl) {
      onError('无法读取网格图，请重新生成');
      return;
    }
    setExtracting(true);
    try {
      const grid = await extractGridCells(workflow.gridImageUrl);
      setExtractedGrid(grid);
      setTunerOpen(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : '切帧失败');
    } finally {
      setExtracting(false);
    }
  }, [workflow.gridImageUrl, onError]);

  const handleTunerGenerate = useCallback((frames: ImageData[]) => {
    workflow.encodeTunedGif(frames, { loop, frameDelayMs, loopCount, framePadding });
  }, [workflow, loop, frameDelayMs, loopCount, framePadding]);

  const handleTunerClose = useCallback(() => {
    setTunerOpen(false);
    setExtractedGrid(null);
  }, []);

  const handleBackToReview = useCallback(() => {
    if (workflow.job) {
      // 将状态改回 review_grid，允许用户重新生成 GIF
      workflow.updateJobStatus?.('review_grid');
    }
  }, [workflow]);

  const canSubmit = prompt.trim().length > 0 && !generating && hasApiKey && gifModelOptions.length > 0;
  const refImageCount = refFiles.length;
  const maxedOut = refImageCount >= GIF_MAX_REF_IMAGES;

  const handleClearClick = useCallback(() => {
    setPrompt('');
    setRefFiles([]);
    setUploadError(null);
  }, []);

  const gridActionPayload = useMemo<ImageActionPayload | undefined>(() => {
    if (!workflow.job || !workflow.gridImageUrl) return undefined;
    return {
      id: `${workflow.job.id}-grid`,
      name: `gif-grid-${workflow.job.id}`,
      src: workflow.gridImageUrl,
      storedRef: workflow.job.gridImageRef
        ? { jobId: workflow.job.id, imageRef: workflow.job.gridImageRef, imageIndex: 0 }
        : undefined,
      sourceKind: 'gif',
      sourceLabel: 'GIF 网格图',
      sourceRef: workflow.job.id,
      prompt: workflow.job.prompt,
    };
  }, [workflow.gridImageUrl, workflow.job]);

  return (
    <div ref={dropRef} className="space-y-4">
      <div className={cn(
        'grid grid-cols-1 gap-4 md:grid-cols-2 md:auto-rows-fr',
        wideMode && 'xl:mx-auto xl:max-w-[1500px] xl:grid-cols-[minmax(420px,0.85fr)_minmax(0,1.15fr)]'
      )}>
        <GifParametersPanel
          prompt={prompt}
          onPromptChange={setPrompt}
          model={model}
          modelOptions={gifModelOptions}
          modelPopoverOpen={modelPopoverOpen}
          onModelPopoverOpenChange={setModelPopoverOpen}
          onModelChange={handleModelChange}
          gptImageAdvancedParams={gptImageAdvancedParams}
          onGptImageAdvancedParamsChange={value => {
            setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(model, value));
          }}
          closedLoop={closedLoop}
          onClosedLoopToggle={setClosedLoop}
          refFiles={refFiles}
          onRemoveRef={handleRemoveRef}
          maxedOut={maxedOut}
          isDragOver={isDragOver}
          uploading={uploading}
          uploadError={uploadError}
          onDrop={handleDrop}
          onDragOver={event => { event.preventDefault(); if (hasApiKey) setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onFileSelect={handleFileSelect}
          disabled={!hasApiKey}
          generating={generating}
          canSubmit={canSubmit}
          onSubmit={handleSubmitClick}
          onConfigureApiKey={() => setMissingKeyOpen(true)}
          onOptimize={handleOptimize}
          onClear={handleClearClick}
        />
        <GifReviewPanel
          status={status}
          job={workflow.job}
          gridImageUrl={workflow.gridImageUrl}
          gifBlob={workflow.gifBlob}
          elapsedSeconds={elapsedSeconds}
          gifReady={workflow.gifReady}
          loop={loop}
          onLoopToggle={setLoop}
          frameDelayMs={frameDelayMs}
          onFrameDelayChange={setFrameDelayMs}
          loopCount={loopCount}
          onLoopCountChange={setLoopCount}
          framePadding={framePadding}
          onFramePaddingChange={setFramePadding}
          onOpenPreview={() => setPreviewOpen(true)}
          onEncodeGif={handleEncodeGif}
          onDownloadAgain={() => workflow.downloadGif()}
          onRetryRegenerate={handleSubmitClick}
          onReset={handleResetClick}
          onRefreshFromServer={() => {
            setRefreshCooldownActive(true);
            setRefreshCooldownEnd(Date.now() + 5000);
            void workflow.refreshFromServer((msg) => {
            const type = (msg.includes('失败') || msg.includes('错误')) ? 'error' as const : 'info' as const;
            if (showToast) showToast(msg, type);
            else onError(msg);
            });
          }}
          isSyncing={workflow.isSyncing}
          refreshCooldownActive={refreshCooldownActive}
          onBackToReview={handleBackToReview}
          gridActionPayload={gridActionPayload}
        />
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        系统会自动把生成网格图并切片为GIF，搭配你填写的主题与可选的参考图，生成 3×4 = 12 帧的网格底图，再在本地切片合成 GIF。
        网格图分辨率固定为 3264×2448（单帧 816×816 正方形），仅显示支持 4K 自定义分辨率的 image 系列模型。
        banana 系列不支持当前动图网格所需的自定义分辨率，因此这里不提供选择。
      </p>

      {previewOpen && workflow.gridImageUrl && createPortal(
        <HistoryImagePreview
          images={[workflow.gridImageUrl]}
          alt="GIF 网格底图"
          onClose={() => setPreviewOpen(false)}
          actionPayloads={gridActionPayload ? [gridActionPayload] : undefined}
        />,
        document.body,
      )}

      {overwriteOpen && createPortal(
        <ConfirmDialog
          title="覆盖当前工作流？"
          message="当前已有一个未完成或未导出的动图任务，重新生成将清空它。是否继续？"
          confirmText="覆盖并重新生成"
          onConfirm={() => {
            setOverwriteOpen(false);
            void performSubmit();
          }}
          onCancel={() => setOverwriteOpen(false)}
        />,
        document.body,
      )}

      {resetOpen && createPortal(
        <ConfirmDialog
          title="清空当前工作流？"
          message="将删除本地缓存的网格图和当前任务，注意保存好已生成的 GIF。是否继续？"
          confirmText="清空"
          onConfirm={() => {
            setResetOpen(false);
            void workflow.resetJob();
          }}
          onCancel={() => setResetOpen(false)}
        />,
        document.body,
      )}

      <MissingApiKeyDialog
        open={missingKeyOpen}
        onOpenChange={setMissingKeyOpen}
        onConfigure={onConfigureApiKey}
      />

      {modeChoiceOpen && createPortal(
        <GifModeChoiceDialog
          onAuto={handleAutoGenerate}
          onTune={() => void handleTuneGenerate()}
          onCancel={() => setModeChoiceOpen(false)}
        />,
        document.body,
      )}

      {extracting && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
            <span className="text-sm">正在切分网格帧…</span>
          </div>
        </div>,
        document.body,
      )}

      {tunerOpen && extractedGrid && createPortal(
        <GifFrameTuner
          cells={extractedGrid.cells}
          cellWidth={extractedGrid.cellWidth}
          cellHeight={extractedGrid.cellHeight}
          onGenerate={handleTunerGenerate}
          onClose={handleTunerClose}
        />,
        document.body,
      )}

      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={(open) => { if (!open) handleOptimizeCancel(); setOptimizeOpen(open); }}
        originalPrompt={prompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />
    </div>
  );
}
