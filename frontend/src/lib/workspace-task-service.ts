import {
  createNovaTask,
  ackNovaTask,
  resolveImageTaskProvider,
  type NovaTaskResponse,
  type ImageReference,
} from '@/lib/ccode-task-client';
import type { ModelId } from '@/lib/gemini-config';
import type { AspectRatio, OutputSize, StoredJob } from '@/lib/job-store';
import {
  getGptImageAdvancedParamsForModel,
  resolveSubmitLayout,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import { generateUUID } from '@/lib/uuid';
import { downloadAndStoreImages, type DownloadResult, type ImageDownloadProgressItem } from '@/lib/image-downloader';

export interface TextToImageSubmitInput {
  prompts: string[];
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  model: string;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  parallelCount: ParallelCount;
}

export interface ImageToImageSubmitInput {
  prompt: string;
  files: { id: string; name: string; dataUrl: string; mimeType: string }[];
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  model: string;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  parallelCount: ParallelCount;
}

export interface SubmitActions {
  addJob: (job: StoredJob) => void;
  replaceJob: (jobId: string, updater: (job: StoredJob) => StoredJob) => void;
  completeJob: (jobId: string, job: StoredJob) => Promise<void>;
  failJob: (jobId: string, error: string, options?: { terminal?: boolean }) => Promise<void>;
  /** 可选：返回最新 job 快照，供异步流程避免使用过期闭包。 */
  getJob?: (jobId: string) => StoredJob | undefined;
}

function buildImageDownloadProgress(items: ImageDownloadProgressItem[]): StoredJob['imageDownloadProgress'] {
  if (items.length === 0) return undefined;
  return {
    total: items.length,
    completed: items.filter(item => item.status === 'cached').length,
    failed: items.filter(item => item.status === 'failed').length,
    items,
  };
}

function createInitialImageDownloadProgress(images: string[]): StoredJob['imageDownloadProgress'] {
  return buildImageDownloadProgress(images.map((image, index) => ({
    index,
    status: image.startsWith('URL:') ? 'pending' : 'cached',
    loadedBytes: 0,
  })));
}

function applyImageDownloadProgress(
  actions: SubmitActions,
  jobId: string,
  images: string[],
  item: ImageDownloadProgressItem,
): void {
  actions.replaceJob(jobId, current => {
    const currentItems = current.imageDownloadProgress?.items?.length === images.length
      ? current.imageDownloadProgress.items
      : createInitialImageDownloadProgress(images)?.items || [];
    const items = currentItems.map(existing => (
      existing.index === item.index ? { ...existing, ...item } : existing
    ));
    return {
      ...current,
      imageDownloadProgress: buildImageDownloadProgress(items),
    };
  });
}

function buildImageReferences(files: ImageToImageSubmitInput['files']): ImageReference[] {
  return files.map(file => ({
    data: file.dataUrl.split(',')[1] || file.dataUrl,
    mimeType: file.mimeType,
  }));
}

function createBaseJob(
  mode: StoredJob['mode'],
  prompt: string,
  outputSize: OutputSize,
  customSize: string | undefined,
  aspectRatio: AspectRatio,
  temperature: number,
  model: string,
  gptImageQuality: GptImageQuality,
  gptImageStyle: GptImageStyle,
  gptImageBackground: GptImageBackground,
  parallelCount: ParallelCount,
  refImages?: StoredJob['refImages']
): StoredJob {
  const advancedParams = getGptImageAdvancedParamsForModel(model as ModelId, {
    quality: gptImageQuality,
    style: gptImageStyle,
    background: gptImageBackground,
  });

  return {
    id: generateUUID(),
    status: 'processing',
    mode,
    prompt,
    originalPrompt: prompt,
    output_size: outputSize,
    custom_size: customSize,
    temperature,
    aspect_ratio: aspectRatio,
    model,
    gptImageQuality: advancedParams.quality,
    gptImageStyle: advancedParams.style,
    gptImageBackground: advancedParams.background,
    parallelCount,
    created_at: new Date().toISOString(),
    refImages,
  };
}

export function buildCompletedJobFromTask(job: StoredJob, task: NovaTaskResponse): StoredJob {
  const images = task.result?.images || [];
  if (task.status === 'completed' && images.length > 0) {
    return {
      ...job,
      status: 'completed',
      images,
      imageData: images[0],
      warning: task.warning,
      serverTaskAcked: true,
    };
  }

  return {
    ...job,
    status: 'failed',
    error: task.error || (task.status === 'expired' ? '该任务已超出取回时间' : '后端任务失败'),
  };
}

export async function finalizeCompletedServerTask(
  job: StoredJob,
  task: NovaTaskResponse,
  actions: SubmitActions
): Promise<void> {
  const images = task.result?.images || [];

  if (task.status === 'completed' && images.length > 0) {
    const hasUrlImages = images.some(img => img.startsWith('URL:'));

    if (!hasUrlImages) {
      const finalJob: StoredJob = {
        ...job,
        status: 'completed',
        images,
        imageData: images[0],
        warning: task.warning,
        serverTaskAcked: true,
        imageDownloadProgress: undefined,
      };
      await actions.completeJob(job.id, finalJob);

      if (job.serverTaskId) {
        await ackNovaTask(job.serverTaskId);
      }
      return;
    }

    await actions.completeJob(job.id, {
      ...job,
      status: 'completed',
      images,
      imageData: images[0],
      warning: task.warning,
      serverTaskAcked: false,
      blobUrls: undefined,
      imageDownloadProgress: createInitialImageDownloadProgress(images),
    });

    const result: DownloadResult = await downloadAndStoreImages(job.id, images, {
      onProgress: item => applyImageDownloadProgress(actions, job.id, images, item),
    });
    const finalImages = images.map((img, index) => (
      img.startsWith('URL:') && result.blobUrls[index] ? result.blobUrls[index] : img
    ));
    const blobUrls = result.blobUrls.filter(url => url && url.startsWith('blob:'));
    const remainingUrlCount = finalImages.filter(img => img.startsWith('URL:')).length;
    const allCached = remainingUrlCount === 0;
    const finalJob: StoredJob = {
      ...job,
      status: 'completed',
      images: finalImages,
      imageData: finalImages[0],
      warning: allCached
        ? task.warning
        : result.successCount === 0
          ? '本地缓存创建失败，已通过远程 URL 渲染。可点击「重新下载」重试缓存，或尽快保存图片（约 12 小时后服务端清理）。'
          : `${result.failCount} 张图片本地缓存失败（已通过远程 URL 渲染），已完成 ${result.successCount} 张。可点击「重新下载」重试缓存。`,
      serverTaskAcked: allCached,
      blobUrls: blobUrls.length > 0 ? blobUrls : undefined,
      imageDownloadProgress: allCached ? undefined : buildImageDownloadProgress(result.items),
    };
    await actions.completeJob(job.id, finalJob);

    if (allCached && job.serverTaskId) {
      await ackNovaTask(job.serverTaskId);
    }
    return;
  }

  const finalJob: StoredJob = {
    ...job,
    status: 'failed',
    error: task.error || (task.status === 'expired' ? '该任务已超出取回时间' : '后端任务失败'),
  };
  await actions.failJob(job.id, finalJob.error || '任务失败');
}

export interface RetryDownloadResult {
  successCount: number;
  failCount: number;
  /** 仍以 URL: 开头、未能缓存到本地的图片张数（部分或全部）。 */
  remainingUrlCount: number;
}

/**
 * 重新下载并缓存仍以 URL: 开头的图片到 IndexedDB。
 * 用于"重新下载"按钮：当首次自动缓存因弱网、浏览器或 IndexedDB 环境原因失败时，
 * 用户可手动触发再次缓存，并复用同一套流式进度反馈。
 *
 * 行为：
 * - 仅对 job.images 中以 URL: 开头的项执行下载；blob:/data:/IDB: 项保持不变。
 * - 全部成功：清空 warning，调用 ackNovaTask 让服务端按 2 分钟规则清理。
 * - 部分/全部失败：保留 URL: 前缀，更新 warning 数量，不调用 ack（服务端继续保留）。
 * - 不抛异常；调用方根据返回值显示 toast。
 */
export async function retryDownloadCachedImages(
  job: StoredJob,
  actions: SubmitActions,
): Promise<RetryDownloadResult> {
  const sourceImages = job.images || (job.imageData ? [job.imageData] : []);
  const urlIndices = sourceImages
    .map((img, index) => (img.startsWith('URL:') ? index : -1))
    .filter(index => index >= 0);

  if (urlIndices.length === 0) {
    return { successCount: 0, failCount: 0, remainingUrlCount: 0 };
  }

  actions.replaceJob(job.id, current => ({
    ...current,
    imageDownloadProgress: createInitialImageDownloadProgress(sourceImages),
  }));

  const result = await downloadAndStoreImages(job.id, sourceImages, {
    onProgress: item => applyImageDownloadProgress(actions, job.id, sourceImages, item),
  });
  const mergedImages = sourceImages.map((image, index) => (
    image.startsWith('URL:') && result.blobUrls[index] ? result.blobUrls[index] : image
  ));
  const newBlobUrls = result.blobUrls.filter(url => url && url.startsWith('blob:'));

  const remainingUrlCount = mergedImages.filter(img => img.startsWith('URL:')).length;
  const allCached = remainingUrlCount === 0;
  const existingBlobUrls = job.blobUrls || [];
  const combinedBlobUrls = [...existingBlobUrls, ...newBlobUrls];

  const updatedJob: StoredJob = {
    ...job,
    status: 'completed',
    images: mergedImages,
    imageData: mergedImages[0],
    warning: allCached
      ? undefined
      : `${remainingUrlCount} 张图片本地缓存仍未成功（已通过远程 URL 渲染），可继续点击「重新下载」重试。`,
    serverTaskAcked: allCached ? true : false,
    blobUrls: combinedBlobUrls.length > 0 ? combinedBlobUrls : undefined,
    imageDownloadProgress: allCached ? undefined : buildImageDownloadProgress(result.items),
  };

  await actions.completeJob(job.id, updatedJob);

  if (allCached && job.serverTaskId && !job.serverTaskAcked) {
    await ackNovaTask(job.serverTaskId);
  }

  return {
    successCount: result.successCount,
    failCount: result.failCount,
    remainingUrlCount,
  };
}

export async function submitTextToImage(
  input: TextToImageSubmitInput,
  actions: SubmitActions,
  onError: (message: string) => void
): Promise<void> {
  const provider = resolveImageTaskProvider(input.model);
  const apiKey = provider.apiKey;

  if (!apiKey) {
    onError('请先配置 API 密钥');
    return;
  }

  for (const prompt of input.prompts) {
    const layout = resolveSubmitLayout(input.model as ModelId, input.outputSize, input.aspectRatio, prompt);
    const job = createBaseJob(
      'text-to-image',
      prompt,
      layout.outputSize,
      input.customSize,
      layout.aspectRatio,
      input.temperature,
      input.model,
      input.gptImageQuality,
      input.gptImageStyle,
      input.gptImageBackground,
      input.parallelCount
    );
    actions.addJob(job);

    try {
      const serverTaskId = await createNovaTask({
        apiKey,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        mode: 'text-to-image',
        prompt,
        outputSize: layout.outputSize,
        customSize: input.customSize,
        aspectRatio: layout.aspectRatio,
        temperature: input.temperature,
        model: provider.modelId,
        gptImageQuality: input.gptImageQuality,
        gptImageStyle: input.gptImageStyle,
        gptImageBackground: input.gptImageBackground,
        parallelCount: input.parallelCount,
        images: [],
      });

      actions.replaceJob(job.id, current => ({
        ...current,
        status: '排队中',
        serverTaskId,
      }));
    } catch (error) {
      await actions.failJob(job.id, error instanceof Error ? error.message : String(error));
    }
  }
}

export async function submitImageToImage(
  input: ImageToImageSubmitInput,
  actions: SubmitActions,
  onError: (message: string) => void
): Promise<void> {
  const provider = resolveImageTaskProvider(input.model);
  const apiKey = provider.apiKey;

  if (!apiKey) {
    onError('请先配置 API 密钥');
    return;
  }

  const refImages = input.files.map(file => ({
    id: file.id,
    name: file.name,
    dataUrl: file.dataUrl,
    mimeType: file.mimeType,
  }));
  const imageReferences = buildImageReferences(input.files);
  const layout = resolveSubmitLayout(input.model as ModelId, input.outputSize, input.aspectRatio, input.prompt);
  const job = createBaseJob(
    'image-to-image',
    input.prompt,
    layout.outputSize,
    input.customSize,
    layout.aspectRatio,
    input.temperature,
    input.model,
    input.gptImageQuality,
    input.gptImageStyle,
    input.gptImageBackground,
    input.parallelCount,
    refImages
  );

  actions.addJob(job);

  try {
    const serverTaskId = await createNovaTask({
      apiKey,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      mode: 'image-to-image',
      prompt: input.prompt,
      outputSize: layout.outputSize,
      customSize: input.customSize,
      aspectRatio: layout.aspectRatio,
      temperature: input.temperature,
      model: provider.modelId,
      gptImageQuality: input.gptImageQuality,
      gptImageStyle: input.gptImageStyle,
      gptImageBackground: input.gptImageBackground,
      parallelCount: input.parallelCount,
      images: imageReferences,
    });

    actions.replaceJob(job.id, current => ({
      ...current,
      status: '排队中',
      serverTaskId,
    }));
  } catch (error) {
    await actions.failJob(job.id, error instanceof Error ? error.message : String(error));
  }
}
