/**
 * 插件任务与素材上传的 HTTP 客户端。
 *
 * 与内置图片任务分开一条端点：插件任务的载荷形状由 ui.schema 决定，
 * 且服务端要按 pluginId 找到对应的 provider.json 才知道怎么发上游请求。
 */

import type { FacetValues, FieldValues, MediaKind } from '@/lib/plugin-schema';

export interface CreatePluginTaskPayload {
  pluginId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  facets: FacetValues;
  fields: FieldValues;
  /** 素材字段 key → 已上传素材的公网 URL（有序） */
  media: Record<string, string[]>;
}

/** 宿主统一的产物结构。历史记录只认这一种形状，插件卸载后旧记录依然能预览。 */
export interface PluginAsset {
  kind: string;
  url: string;
  posterUrl?: string;
  durationSec?: number;
  mime?: string;
}

export interface PluginTaskResponse {
  id: string;
  /** 本机队列状态：排队中 = 在等本机并发名额，processing = 已交给上游 */
  status: 'queued' | '排队中' | 'processing' | 'completed' | 'failed' | 'expired';
  /** 上游返回的真实进度（0-100）。上游没给这个字段时为 undefined，不要用时间估算顶替 */
  progress?: number;
  /** 上游归一化后的状态。上游自己也会排队，那时 status 还是 processing */
  upstreamStatus?: 'queued' | 'processing' | 'completed' | 'failed';
  pluginId?: string;
  pluginVersion?: string;
  model?: string;
  result?: { assets?: PluginAsset[] };
  error?: string;
  warning?: string;
  createdAt?: string;
  completedAt?: string;
  expiresAt?: string;
}

const DEFAULT_TIMEOUT_MS = 60000;
const UPLOAD_TIMEOUT_MS = 120000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function createPluginTask(payload: CreatePluginTaskPayload): Promise<string> {
  const response = await fetchWithTimeout('/api/nova/plugin-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.message || `任务创建失败: ${response.status}`);
  }

  const data = await response.json();
  if (!data.taskId) throw new Error('未收到有效任务 ID');
  return data.taskId;
}

export async function getPluginTask(taskId: string): Promise<PluginTaskResponse> {
  const response = await fetchWithTimeout(`/api/nova/plugin-tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    cache: 'no-store',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.message || `查询任务失败: ${response.status}`);
  }
  return response.json();
}

export async function ackPluginTask(taskId: string): Promise<void> {
  await fetch(`/api/nova/plugin-tasks/${encodeURIComponent(taskId)}/ack`, {
    method: 'POST',
  }).catch(() => undefined);
}

export interface UploadedMedia {
  url: string;
}

export interface UploadMediaOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function parseUploadResponse(rawText: string, status: number): UploadedMedia {
  let data: Record<string, unknown> = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = {};
  }

  if (status < 200 || status >= 300) {
    const message = (typeof data.error === 'string' && data.error)
      || (typeof data.message === 'string' && data.message)
      || `素材上传失败: ${status}`;
    throw new Error(message);
  }
  if (typeof data.url !== 'string' || !data.url) {
    throw new Error('上传成功但未返回素材 URL');
  }
  return { url: data.url };
}

/**
 * 上传参考素材。上游普遍只接受 URL，所以素材先落盘在本机后端，再把公网 URL 交给上游拉取。
 * 直接以原始二进制发送（Content-Type 即文件 MIME），避免 multipart 解析与 base64 膨胀。
 *
 * 用 XMLHttpRequest 而不是 fetch：fetch 至今没有上传进度事件，而 50MB 的视频不给进度
 * 用户只能盯着一个不动的转圈。
 */
export function uploadPluginMedia(
  pluginId: string,
  file: File,
  kind: MediaKind,
  options: UploadMediaOptions = {},
): Promise<UploadedMedia> {
  const { onProgress, signal, timeoutMs = UPLOAD_TIMEOUT_MS } = options;

  return new Promise<UploadedMedia>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('上传已取消'));
      return;
    }

    const query = `pluginId=${encodeURIComponent(pluginId)}&kind=${encodeURIComponent(kind)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/nova/plugin-media?${query}`);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    if (onProgress) {
      xhr.upload.onprogress = event => {
        onProgress(event.loaded, event.lengthComputable ? event.total : 0);
      };
    }

    xhr.onload = () => {
      cleanup();
      try {
        const result = parseUploadResponse(xhr.responseText, xhr.status);
        // 服务端已收全，进度条补到 100%——upload.onprogress 的最后一帧不保证送达
        onProgress?.(file.size, file.size);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('素材上传失败：网络错误')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error(`素材上传超时（${Math.round(timeoutMs / 1000)}秒）`)); };
    xhr.onabort = () => { cleanup(); reject(new Error('上传已取消')); };

    xhr.send(file);
  });
}

/**
 * 探测产物直链是否仍然可用。上游返回的地址通常只保留数小时，且响应里没有任何
 * 过期时间字段，所以只能在用户真正要看/要下载时探一次。
 *
 * 用媒体元素而不是 fetch：上游 CDN 基本不带 CORS 头，fetch 会直接抛 TypeError，
 * 分不清「链接死了」和「跨域被拦」——那样会把好端端的视频误判成过期并怂恿用户删记录。
 */
export function probeMediaUrl(url: string, timeoutMs = 12000): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  if (typeof document === 'undefined') return Promise.resolve(true);

  return new Promise<boolean>(resolve => {
    const video = document.createElement('video');
    let settled = false;

    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      // 中断仍在进行的请求，避免探测把整段视频拖下来。jsdom 没实现 load()，容错处理。
      try { video.load(); } catch { /* 非浏览器环境 */ }
      resolve(alive);
    };

    // 超时不判死：慢网络下拿不到 metadata 很常见，误删记录比多等一次严重得多
    const timer = setTimeout(() => finish(true), timeoutMs);

    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => finish(true);
    video.onerror = () => finish(false);
    video.src = url;
  });
}
