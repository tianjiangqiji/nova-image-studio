import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ackNovaTask, createNovaTask, resolveImageTaskProvider, type NovaTaskResponse } from '@/lib/ccode-task-client';
import { downloadAndStoreImages } from '@/lib/image-downloader';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import type { StoredJob } from '@/lib/job-store';
import { saveRegistry } from '@/lib/nova-models';
import {
  finalizeCompletedServerTask,
  submitTextToImage,
  type SubmitActions,
} from '@/lib/workspace-task-service';
vi.mock('@/lib/ccode-task-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ccode-task-client')>();
  return {
    ...actual,
    ackNovaTask: vi.fn(),
    createNovaTask: vi.fn(),
    resolveImageTaskProvider: vi.fn(),
  };
});

vi.mock('@/lib/image-downloader', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/image-downloader')>();
  return {
    ...actual,
    downloadAndStoreImages: vi.fn(),
  };
});

const mockedAckNovaTask = vi.mocked(ackNovaTask);
const mockedCreateNovaTask = vi.mocked(createNovaTask);
const mockedDownloadAndStoreImages = vi.mocked(downloadAndStoreImages);
const mockedResolveImageTaskProvider = vi.mocked(resolveImageTaskProvider);

function makeJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 'job-1',
    status: 'processing',
    mode: 'text-to-image',
    prompt: 'prompt',
    output_size: '1K',
    temperature: 1,
    aspect_ratio: '1:1',
    model: 'gemini-3-pro-image-preview',
    created_at: '2026-06-07T00:00:00.000Z',
    serverTaskId: 'task-1',
    ...overrides,
  };
}

function makeCompletedTask(images: string[]): NovaTaskResponse {
  return {
    id: 'task-1',
    status: 'completed',
    result: { images },
  };
}

function createActions(initialJob: StoredJob): { actions: SubmitActions; getJob: () => StoredJob } {
  let currentJob = initialJob;
  const actions: SubmitActions = {
    addJob: vi.fn(),
    replaceJob: vi.fn((_jobId, updater) => {
      currentJob = updater(currentJob);
    }),
    completeJob: vi.fn(async (_jobId, job) => {
      currentJob = job;
    }),
    failJob: vi.fn(async (_jobId, error) => {
      currentJob = { ...currentJob, status: 'failed', error };
    }),
  };

  return {
    actions,
    getJob: () => currentJob,
  };
}

beforeEach(() => {
  localStorage.clear();
  saveRegistry({
    imageModels: [{
      id: 'gpt-image-2',
      protocol: 'openai',
      name: 'GPT Image 2',
      modelId: 'gpt-image-2',
      apiKey: 'test-api-key',
      baseUrl: 'https://api.openai.com',
      builtinPreset: 'gpt-image-2',
      maxRefImages: 16,
      maxOutputSize: '4K',
      supportsAdvancedParams: true,
    }],
    textModels: [],
    defaults: {
      textToImage: 'gpt-image-2',
      imageToImage: 'gpt-image-2',
      reversePrompt: '',
      agent: '',
      promptOptimize: '',
      imageDescribe: '',
      sliceDecomposition: '',
      sliceReconstruct: '',
      sliceImageEdit: '',
    },
  });
  syncDynamicModelExports();
  mockedAckNovaTask.mockReset();
  mockedAckNovaTask.mockResolvedValue(undefined);
  mockedCreateNovaTask.mockReset();
  mockedCreateNovaTask.mockResolvedValue('task-advanced-1');
  mockedDownloadAndStoreImages.mockReset();
  mockedResolveImageTaskProvider.mockReset();
  mockedResolveImageTaskProvider.mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai',
    modelId: 'gpt-image-2',
  });
});

describe('submitTextToImage', () => {
  it('passes GPT Image advanced params into createNovaTask payload', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await submitTextToImage({
      prompts: ['cut out subject'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-api-key',
      mode: 'text-to-image',
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
    }));
    expect(actions.addJob).toHaveBeenCalledWith(expect.objectContaining({
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
    }));
    expect(getJob().serverTaskId).toBe('task-advanced-1');
  });

  it('adapts Gemini auto layout from 淘宝主图3:4 before creating the task', async () => {
    mockedResolveImageTaskProvider.mockReturnValue({
      apiKey: 'test-api-key',
      baseUrl: 'https://example.test',
      protocol: 'openai',
      modelId: 'gemini-3.1-flash-image',
    });
    saveRegistry({
      imageModels: [{
        id: 'gemini-flash',
        protocol: 'openai',
        name: 'Gemini Flash',
        modelId: 'gemini-3.1-flash-image',
        apiKey: 'test-api-key',
        baseUrl: 'https://example.test',
        builtinPreset: 'antigravity-gemini-image',
        maxRefImages: 3,
        maxOutputSize: '4K',
        supportsAdvancedParams: false,
      }],
      textModels: [],
      defaults: {
        textToImage: 'gemini-flash',
        imageToImage: 'gemini-flash',
        reversePrompt: '',
        agent: '',
        promptOptimize: '',
        imageDescribe: '',
        sliceDecomposition: '',
        sliceReconstruct: '',
        sliceImageEdit: '',
      },
    });
    syncDynamicModelExports();

    const job = makeJob({ model: 'gemini-flash' });
    const { actions } = createActions(job);

    await submitTextToImage({
      prompts: ['淘宝主图3:4'],
      outputSize: 'auto',
      aspectRatio: 'auto',
      temperature: 1,
      model: 'gemini-flash',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '淘宝主图3:4',
      outputSize: '1K',
      aspectRatio: '3:4',
      model: 'gemini-3.1-flash-image',
    }));
    expect(actions.addJob).toHaveBeenCalledWith(expect.objectContaining({
      output_size: '1K',
      aspect_ratio: '3:4',
    }));
  });
});

describe('finalizeCompletedServerTask', () => {
  it('全部 URL 图片缓存成功后替换为 blob URL 并 ack 服务端任务', async () => {
    mockedDownloadAndStoreImages.mockImplementation(async (_jobId, _imageRefs, options) => {
      options?.onProgress?.({ index: 0, status: 'downloading', loadedBytes: 5, totalBytes: 10, percent: 50 });
      options?.onProgress?.({ index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 });
      return {
        successCount: 1,
        failCount: 0,
        blobUrls: ['blob:cached-0'],
        items: [{ index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 }],
      };
    });
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask(['URL:/api/nova/images/task-1/0']), actions);

    expect(actions.completeJob).toHaveBeenCalledTimes(2);
    expect(getJob().images).toEqual(['blob:cached-0']);
    expect(getJob().serverTaskAcked).toBe(true);
    expect(getJob().imageDownloadProgress).toBeUndefined();
    expect(mockedAckNovaTask).toHaveBeenCalledWith('task-1');
  });

  it('部分 URL 图片缓存失败时保留 URL 引用和失败进度且不 ack', async () => {
    mockedDownloadAndStoreImages.mockImplementation(async (_jobId, _imageRefs, options) => {
      options?.onProgress?.({ index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 });
      options?.onProgress?.({ index: 1, status: 'failed', loadedBytes: 2, totalBytes: 10, percent: 20, error: 'stream failed' });
      return {
        successCount: 1,
        failCount: 1,
        blobUrls: ['blob:cached-0', ''],
        items: [
          { index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 },
          { index: 1, status: 'failed', loadedBytes: 2, totalBytes: 10, percent: 20, error: 'stream failed' },
        ],
      };
    });
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask([
      'URL:/api/nova/images/task-1/0',
      'URL:/api/nova/images/task-1/1',
    ]), actions);

    expect(getJob().images).toEqual([
      'blob:cached-0',
      'URL:/api/nova/images/task-1/1',
    ]);
    expect(getJob().serverTaskAcked).toBe(false);
    expect(getJob().warning).toContain('1 张图片本地缓存失败');
    expect(getJob().imageDownloadProgress?.failed).toBe(1);
    expect(mockedAckNovaTask).not.toHaveBeenCalled();
  });
});
