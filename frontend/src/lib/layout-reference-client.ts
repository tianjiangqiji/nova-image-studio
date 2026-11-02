'use client';

// 构图参考图实时生成
// 把 LayoutSpec 编译成线框示意图指令 → 走真实文生图任务 → 产出参考图 dataUrl。
// 产物同时写入素材库（json 文本 + 线框指令 + 示意图三者同源），随后由工作台作为图生图输入发出。

import {
  createCcodeTask,
  getCcodeTask,
  resolveImageTaskProvider,
  type CcodeTaskResponse,
} from '@/lib/ccode-task-client';
import type { AspectRatio, OutputSize } from '@/lib/job-store';
import { ccodeTaskSocket } from '@/lib/ccode-task-socket';
import { addImageAsset } from '@/lib/asset-store';
import { resolveImagePayloadToBlob } from '@/lib/image-actions';
import { isLayoutSpecEmpty, stringifyLayoutSpec, buildLayoutSketchPrompt, type LayoutSpec } from '@/lib/layout-spec';
import { MAX_UPLOAD_SIZE_BYTES } from '@/lib/constants';
import { prepareUploadImage } from '@/lib/upload-image-cache';

/** 参考图排队/生成的最长等待时间，超时按失败处理 */
const LAYOUT_REFERENCE_TIMEOUT_MS = 240000;
/** WebSocket 之外的 HTTP 兜底查询间隔 */
const LAYOUT_REFERENCE_POLL_MS = 3000;

export const LAYOUT_REFERENCE_MISSING_KEY_MESSAGE = '请先在设置中配置可用的图片模型，配置完成后即可生成构图参考图。';

export interface LayoutReferenceImage {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  badge: string;
  /** 本次生成用的线框指令（实时生成，随素材一起落库） */
  prompt: string;
  /** 写入素材库后的图片素材 id */
  assetId: string;
}

export interface GenerateLayoutReferenceInput {
  spec: LayoutSpec;
  model: string;
  outputSize: OutputSize;
  aspectRatio: AspectRatio;
  signal: AbortSignal;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body = ''] = dataUrl.split(',');
  const mimeMatch = header.match(/data:([^;]+);base64/i);
  const mimeType = mimeMatch?.[1] || 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function isTerminalStatus(status: CcodeTaskResponse['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired';
}

/**
 * 等待任务到终态：优先用 WebSocket 订阅推送，同时保留 HTTP 兜底轮询，
 * 任一路径先拿到终态即返回；abort 或超时抛错。
 */
async function waitForTaskResult(taskId: string, signal: AbortSignal): Promise<CcodeTaskResponse> {
  return new Promise<CcodeTaskResponse>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(poller);
      signal.removeEventListener('abort', handleAbort);
      unsubscribe();
    };
    const finish = (task: CcodeTaskResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(task);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const handleAbort = () => fail(new Error('已取消生成参考图'));
    const handleTask = (task: CcodeTaskResponse) => {
      if (isTerminalStatus(task.status)) finish(task);
    };

    const timeout = setTimeout(() => fail(new Error('参考图生成超时，请稍后重试或直接提交文生图')), LAYOUT_REFERENCE_TIMEOUT_MS);
    const poller = setInterval(() => {
      getCcodeTask(taskId).then(handleTask).catch(() => { /* 单次查询失败等下一轮 */ });
    }, LAYOUT_REFERENCE_POLL_MS);

    signal.addEventListener('abort', handleAbort);
    unsubscribe = ccodeTaskSocket.subscribeTask(taskId, handleTask);

    // 任务可能在我们订阅前就已完成，立即补一次查询
    getCcodeTask(taskId).then(handleTask).catch(() => {});
  });
}

export async function generateLayoutReferenceImage(
  input: GenerateLayoutReferenceInput,
): Promise<LayoutReferenceImage> {
  if (isLayoutSpecEmpty(input.spec)) {
    throw new Error('请先在构图模式中创建至少一个物体');
  }

  let provider: ReturnType<typeof resolveImageTaskProvider>;
  try {
    provider = resolveImageTaskProvider(input.model);
  } catch {
    throw new Error(LAYOUT_REFERENCE_MISSING_KEY_MESSAGE);
  }
  if (!provider.apiKey || !provider.baseUrl) {
    throw new Error(LAYOUT_REFERENCE_MISSING_KEY_MESSAGE);
  }

  const sketchPrompt = buildLayoutSketchPrompt(input.spec);
  const layoutJson = stringifyLayoutSpec(input.spec);

  const taskId = await createCcodeTask({
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    mode: 'text-to-image',
    prompt: sketchPrompt,
    outputSize: input.outputSize,
    aspectRatio: input.aspectRatio,
    temperature: 0.4,
    model: provider.modelId,
    parallelCount: 1,
    images: [],
  });

  if (input.signal.aborted) throw new Error('已取消生成参考图');

  const task = await waitForTaskResult(taskId, input.signal);
  if (task.status !== 'completed') {
    throw new Error(task.error || '后端任务失败，参考图未生成');
  }
  const rawImage = (task.result?.images || [])[0];
  if (!rawImage) {
    throw new Error('任务已完成但未返回参考图，请稍后重试');
  }

  const sourceBlob = await resolveImagePayloadToBlob({ src: rawImage, sourceKind: 'image-to-image' });
  const prepared = await prepareUploadImage(new File([sourceBlob], 'layout-reference.png', { type: sourceBlob.type || 'image/png' }));
  if (prepared.processedSize > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error('参考图压缩后仍超过 10MB，无法作为图生图输入');
  }

  // 落库的是发给模型的同一份图；sourceRef 同时带上构图 JSON 便于回查来源规范
  const blob = dataUrlToBlob(prepared.dataUrl);
  const asset = await addImageAsset({
    blob,
    name: '构图参考图',
    sourceKind: 'image-to-image',
    sourceLabel: '构图参考图',
    sourceRef: `${layoutJson.slice(0, 240)}…`,
    prompt: sketchPrompt,
  });

  return {
    id: prepared.id,
    name: prepared.name || '构图参考图',
    dataUrl: prepared.dataUrl,
    mimeType: prepared.mimeType,
    badge: '构图参考图',
    prompt: sketchPrompt,
    assetId: asset.id,
  };
}
