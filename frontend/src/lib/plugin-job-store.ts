/**
 * 插件任务的本地历史记录。
 *
 * 记录里刻意保存了 `paramSummary`（提交时的字段标签 + 取值快照）而不只是原始值：
 * 插件被卸载后 ui.schema 就没了，只存 `{ tier: "standard" }` 这种键值对的话，
 * 旧记录会退化成一堆无意义的字符串。
 */

import type { FacetValues, FieldValues } from '@/lib/plugin-schema';
import type { PluginAsset } from '@/lib/plugin-task-client';

export type PluginJobStatus = 'uploading' | 'queued' | '排队中' | 'processing' | 'completed' | 'failed';

/** 并发子任务。素材只上传一次，多个子任务共享 URL，各自有独立 serverTaskId 与状态 */
export interface PluginSubTask {
  /** 子任务在上游的 ID */
  serverTaskId: string;
  status: PluginJobStatus;
  upstreamStatus?: PluginUpstreamStatus;
  assets?: PluginAsset[];
  error?: string;
  progress?: number;
  completedAt?: string;
  serverTaskAcked?: boolean;
}

/** 上游归一化后的状态，与本机队列状态（PluginJobStatus）分开记 */
export type PluginUpstreamStatus = 'queued' | 'processing' | 'completed' | 'failed';

/** 提交时的参数快照，用于历史卡片展示——不依赖插件是否还装着 */
export interface PluginParamChip {
  label: string;
  value: string;
}

export interface PluginJob {
  id: string;
  serverTaskId?: string;
  status: PluginJobStatus;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  model: string;
  modelLabel: string;
  /** 主提示词（若插件有 textarea 字段），用于搜索与卡片展示 */
  prompt: string;
  facets: FacetValues;
  fields: FieldValues;
  /** 展示用的参数摘要，卸载插件后仍可读 */
  paramSummary: PluginParamChip[];
  estimatedCost: number | null;
  currency: string;
  assets?: PluginAsset[];
  error?: string;
  createdAt: string;
  /** 上游返回的真实生成进度（0-100）。undefined 表示这一轮没拿到，界面改显示已用时间 */
  progress?: number;
  /** 上游那边的状态。status 为 processing 而这里是 queued，说明是上游在排队 */
  upstreamStatus?: PluginUpstreamStatus;
  /** 素材开始上传的时刻；没有素材的纯文本任务不会有这三个字段 */
  uploadStartedAt?: string;
  uploadCompletedAt?: string;
  /** 上游任务创建成功、开始等结果的时刻。用它而不是 createdAt 算生成用时，
   * 否则上传耗时会被算进生成里。 */
  generationStartedAt?: string;
  completedAt?: string;
  /** 并发请求数（1-10）。>1 时素材只上传一次，多个子任务共享 URL */
  parallelCount?: number;
  /** 并发子任务列表。parallelCount>1 时使用，每个子任务有独立的 serverTaskId 与状态 */
  subTasks?: PluginSubTask[];
}

/** 尚未进入终态的状态集合，列表筛选与轮询共用 */
export const ACTIVE_PLUGIN_STATUSES: readonly PluginJobStatus[] = ['uploading', 'queued', '排队中', 'processing'];

export function isActivePluginJob(job: PluginJob): boolean {
  return ACTIVE_PLUGIN_STATUSES.includes(job.status);
}

/** 主产物：目前每个任务只会有一个视频，取第一个即可。 */
export function primaryAsset(job: PluginJob): PluginAsset | undefined {
  return job.assets?.[0];
}

const STORAGE_KEY = 'nova-plugin-jobs';
const MAX_STORED_JOBS = 50;

const EMPTY_JOBS: PluginJob[] = [];

/**
 * 缓存当前列表引用。useSyncExternalStore 要求 getSnapshot 在数据未变时返回同一个引用，
 * 否则每次渲染都会被判定为「外部状态已变」而陷入无限重渲染。
 */
let cachedJobs: PluginJob[] | null = null;

type Listener = (jobs: PluginJob[]) => void;
const listeners = new Set<Listener>();

function notifyListeners(jobs: PluginJob[]) {
  for (const listener of listeners) {
    try {
      listener(jobs);
    } catch (error) {
      console.error('[plugin-job-store] error notifying listener', error);
    }
  }
}

export function subscribePluginJobs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function loadPluginJobs(): PluginJob[] {
  if (typeof window === 'undefined') return EMPTY_JOBS;
  if (cachedJobs) return cachedJobs;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedJobs = EMPTY_JOBS;
      return cachedJobs;
    }
    const parsed = JSON.parse(raw);
    cachedJobs = Array.isArray(parsed) ? (parsed as PluginJob[]) : EMPTY_JOBS;
    return cachedJobs;
  } catch {
    cachedJobs = EMPTY_JOBS;
    return cachedJobs;
  }
}

/** useSyncExternalStore 的快照读取器（引用稳定） */
export function getPluginJobsSnapshot(): PluginJob[] {
  return loadPluginJobs();
}

/** SSR 快照：服务端没有 localStorage，固定返回空列表 */
export function getPluginJobsServerSnapshot(): PluginJob[] {
  return EMPTY_JOBS;
}

export function savePluginJobs(jobs: PluginJob[]): void {
  if (typeof window === 'undefined') return;
  const trimmed = jobs.slice(0, MAX_STORED_JOBS);
  cachedJobs = trimmed;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.error('[plugin-job-store] error saving jobs', error);
  }
  // 即使写盘失败也要通知：内存中的列表已经更新，UI 应保持一致。
  notifyListeners(trimmed);
}

export function addPluginJob(job: PluginJob): void {
  const current = loadPluginJobs();
  savePluginJobs([job, ...current.filter(item => item.id !== job.id)]);
}

export function updatePluginJob(id: string, patch: Partial<PluginJob> | ((job: PluginJob) => PluginJob)): void {
  const current = loadPluginJobs();
  let updated = false;
  const next = current.map(job => {
    if (job.id !== id) return job;
    updated = true;
    return typeof patch === 'function' ? patch(job) : { ...job, ...patch };
  });
  if (updated) savePluginJobs(next);
}

/** 更新某个 job 下某个 subTask 的字段 */
export function updatePluginSubTask(
  jobId: string,
  subTaskId: string,
  updater: Partial<PluginSubTask>,
): void {
  updatePluginJob(jobId, job => {
    if (!job.subTasks) return job;
    const subTasks = job.subTasks.map(st =>
      st.serverTaskId === subTaskId ? { ...st, ...updater } : st
    );
    // 根据子任务状态推导父任务状态
    const allDone = subTasks.every(st => st.status === 'completed' || st.status === 'failed');
    const anyProcessing = subTasks.some(st => st.status === 'processing' || st.status === 'queued' || st.status === '排队中' || st.status === 'uploading');
    const allFailed = subTasks.every(st => st.status === 'failed');
    const completedAssets = subTasks.filter(st => st.assets?.length).flatMap(st => st.assets!);

    let status = job.status;
    let assets = job.assets;
    let error: string | undefined = job.error;
    let completedAt = job.completedAt;

    if (allFailed) {
      status = 'failed';
      error = subTasks.find(st => st.error)?.error || '全部并发任务失败';
      completedAt = new Date().toISOString();
    } else if (allDone) {
      status = 'completed';
      // 父 job 的 assets 取第一个成功的
      assets = completedAssets.length > 0 ? completedAssets : assets;
      completedAt = new Date().toISOString();
    } else if (anyProcessing) {
      status = 'processing';
    }

    return {
      ...job,
      subTasks,
      status,
      assets,
      error,
      completedAt,
    };
  });
}

export function removePluginJob(id: string): void {
  savePluginJobs(loadPluginJobs().filter(job => job.id !== id));
}

export function clearPluginJobs(): void {
  savePluginJobs([]);
}

/** 测试用：丢弃内存快照，强制下次从 localStorage 重新读取 */
export function __resetPluginJobsCacheForTests(): void {
  cachedJobs = null;
}
