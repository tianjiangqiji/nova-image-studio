'use client';

/**
 * 插件任务的执行体：上传素材 → 创建后端任务。
 *
 * 为什么是模块级单例而不是组件状态：左侧工作台负责收集文件，右侧历史列表负责展示进度，
 * 两者在 WorkspaceShell 下是兄弟组件，没有共同的状态容器（plugin-job-store 也是
 * 同样的模块级 store）。
 *
 * 上传时机推迟到用户点「开始生成」之后：选中即上传会让没提交的文件白占磁盘，
 * 而后端的素材绑定只在创建任务时才跑，这些孤儿文件要等 TTL 才清。
 */

import { addPluginJob, loadPluginJobs, updatePluginJob, type PluginJob, type PluginSubTask } from '@/lib/plugin-job-store';
import { createPluginTask, uploadPluginMedia, type CreatePluginTaskPayload } from '@/lib/plugin-task-client';
import type { MediaKind } from '@/lib/plugin-schema';

/** 已选中但尚未上传的素材。file 只在内存里——localStorage 存不了 File。 */
export interface PendingMedia {
  id: string;
  /** 所属素材字段的 key（ui.schema 里的 field.key） */
  slot: string;
  kind: MediaKind;
  file: File;
  /** URL.createObjectURL 生成的本地预览地址，由持有方负责 revoke */
  previewUrl: string;
}

export type UploadItemStatus = 'pending' | 'uploading' | 'done' | 'failed';

export interface UploadItemProgress {
  id: string;
  name: string;
  kind: MediaKind;
  bytes: number;
  loaded: number;
  status: UploadItemStatus;
  error?: string;
  url?: string;
}

/** 上传全部完成后交给调用方拼载荷。key 为素材字段，值为该字段素材的公网 URL（有序）。 */
export type UrlsBySlot = Record<string, string[]>;

export type PayloadBuilder = (urls: UrlsBySlot) => Omit<CreatePluginTaskPayload, 'media'>;

interface RunnerEntry {
  items: PendingMedia[];
  progress: UploadItemProgress[];
  /** 对外暴露的只读快照。useSyncExternalStore 要求 getSnapshot 在数据未变时返回同一个
   * 引用，否则每次渲染都被判定为「外部状态已变」而陷入无限重渲染。 */
  snapshot: UploadItemProgress[];
  pluginId: string;
  buildPayload: PayloadBuilder;
  running: boolean;
  /** 并发任务数。>1 时素材只上传一次，然后并发创建多个上游任务 */
  parallelCount: number;
}

const entries = new Map<string, RunnerEntry>();

type ProgressListener = (progress: UploadItemProgress[]) => void;
const listeners = new Map<string, Set<ProgressListener>>();

function emit(jobId: string): void {
  const entry = entries.get(jobId);
  if (!entry) return;
  entry.snapshot = entry.progress.map(item => ({ ...item }));
  for (const listener of listeners.get(jobId) ?? []) {
    try {
      listener(entry.snapshot);
    } catch (error) {
      console.error('[plugin-upload-runner] error notifying listener', error);
    }
  }
}

export function subscribeUploadProgress(jobId: string, listener: ProgressListener): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(jobId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(jobId);
  };
}

export function getUploadProgress(jobId: string): UploadItemProgress[] | null {
  return entries.get(jobId)?.snapshot ?? null;
}

/** 还有文件留在内存里才谈得上重试；刷新过页面的任务只能删记录重来。 */
export function canRetry(jobId: string): boolean {
  const entry = entries.get(jobId);
  return Boolean(entry) && !entry?.running;
}

/**
 * 顺序上传剩余素材，全部成功后创建后端任务。
 * 顺序而非并发：一次拖 9 个文件并发上传会直接把后端的素材限流打满。
 */
async function run(jobId: string): Promise<void> {
  const entry = entries.get(jobId);
  if (!entry || entry.running) return;
  entry.running = true;

  try {
    for (const item of entry.items) {
      const progress = entry.progress.find(p => p.id === item.id);
      if (!progress || progress.status === 'done') continue; // 重试时跳过已成功项，不重复落盘

      progress.status = 'uploading';
      progress.loaded = 0;
      progress.error = undefined;
      emit(jobId);

      try {
        const { url } = await uploadPluginMedia(entry.pluginId, item.file, item.kind, {
          onProgress: loaded => {
            progress.loaded = loaded;
            emit(jobId);
          },
        });
        progress.status = 'done';
        progress.loaded = progress.bytes;
        progress.url = url;
        emit(jobId);
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败';
        progress.status = 'failed';
        progress.error = message;
        emit(jobId);
        updatePluginJob(jobId, {
          status: 'failed',
          error: `素材「${item.file.name}」上传失败：${message}`,
          completedAt: new Date().toISOString(),
        });
        return;
      }
    }

    const urls: UrlsBySlot = {};
    for (const item of entry.items) {
      const progress = entry.progress.find(p => p.id === item.id);
      if (!progress?.url) continue;
      if (!urls[item.slot]) urls[item.slot] = [];
      urls[item.slot].push(progress.url);
    }

    updatePluginJob(jobId, { uploadCompletedAt: new Date().toISOString() });

    const parallel = Math.max(1, entry.parallelCount);
    const payload = entry.buildPayload(urls);

    try {
      if (parallel === 1) {
        // 单并发走原路径：单个 serverTaskId 直接写在 job 上
        const serverTaskId = await createPluginTask({ ...payload, media: urls });
        updatePluginJob(jobId, {
          status: 'processing',
          serverTaskId,
          generationStartedAt: new Date().toISOString(),
        });
      } else {
        // 并发：同一份素材 URL 创建 N 个上游任务，存为 subTasks
        const subTaskPromises = Array.from({ length: parallel }, () =>
          createPluginTask({ ...payload, media: urls }),
        );
        const results = await Promise.allSettled(subTaskPromises);
        const subTasks: PluginSubTask[] = results.map((result, idx) =>
          result.status === 'fulfilled'
            ? { serverTaskId: result.value, status: 'processing' as const }
            : { serverTaskId: `failed_${idx}`, status: 'failed' as const, error: result.reason instanceof Error ? result.reason.message : '创建任务失败' },
        );
        const anyCreated = subTasks.some(st => st.status === 'processing');
        if (anyCreated) {
          updatePluginJob(jobId, {
            status: 'processing',
            generationStartedAt: new Date().toISOString(),
            subTasks,
          });
        } else {
          throw new Error(subTasks[0]?.error || '全部并发任务创建失败');
        }
      }
      // 任务已交给后端，素材已绑定，内存里的 File 不再需要
      entries.delete(jobId);
      listeners.delete(jobId);
    } catch (error) {
      updatePluginJob(jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : '创建任务失败',
        completedAt: new Date().toISOString(),
      });
    }
  } finally {
    const current = entries.get(jobId);
    if (current) current.running = false;
  }
}

export interface StartJobInput {
  job: PluginJob;
  items: PendingMedia[];
  buildPayload: PayloadBuilder;
  /** 并发请求数（1-10），默认 1。>1 时素材只上传一次 */
  parallelCount?: number;
}

/** 落一条 uploading 记录并立刻开跑。 */
export function startPluginJob({ job, items, buildPayload, parallelCount = 1 }: StartJobInput): void {
  const now = new Date().toISOString();
  const progress: UploadItemProgress[] = items.map(item => ({
    id: item.id,
    name: item.file.name,
    kind: item.kind,
    bytes: item.file.size,
    loaded: 0,
    status: 'pending',
  }));
  entries.set(job.id, {
    items,
    pluginId: job.pluginId,
    buildPayload,
    running: false,
    progress,
    snapshot: progress.map(item => ({ ...item })),
    parallelCount: Math.min(10, Math.max(1, parallelCount)),
  });

  addPluginJob({ ...job, status: 'uploading', uploadStartedAt: now });
  void run(job.id);
}

/** 重试：只重传失败与未开始的项，已成功的沿用原 URL。 */
export function retryPluginJob(jobId: string): void {
  const entry = entries.get(jobId);
  if (!entry || entry.running) return;
  updatePluginJob(jobId, {
    status: 'uploading',
    error: undefined,
    completedAt: undefined,
    uploadStartedAt: new Date().toISOString(),
  });
  void run(jobId);
}

/**
 * 页面刷新后内存里的 File 全没了，但 localStorage 里的任务还停在 uploading，
 * 不处理的话卡片会永远转圈。启动时统一标失败。
 */
export function reconcileInterruptedUploads(): void {
  for (const job of loadPluginJobs()) {
    if (job.status !== 'uploading' || entries.has(job.id)) continue;
    updatePluginJob(job.id, {
      status: 'failed',
      error: '素材上传中断（页面已刷新），请重新提交任务',
      completedAt: new Date().toISOString(),
    });
  }
}

export function __resetUploadRunnerForTests(): void {
  entries.clear();
  listeners.clear();
}
