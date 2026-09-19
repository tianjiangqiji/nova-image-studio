import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import { makeStoredBlobRef, deleteStoredBlobs, type ImageDownloadProgressItem } from '@/lib/image-downloader';
import { openImageDb, IMG_STORE } from '@/lib/image-db';

export type Mode = 'text-to-image' | 'image-to-image' | 'prompt-gallery';
export type OutputSize = 'auto' | '512' | '1K' | '2K' | '4K';
export type AspectRatio = 'auto' | '1:1' | '1:4' | '1:8' | '2:3' | '3:2' | '3:4' | '4:1' | '4:3' | '4:5' | '5:4' | '8:1' | '9:16' | '16:9' | '21:9';

export interface RefImageData {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

export interface ImageDownloadProgress {
  total: number;
  completed: number;
  failed: number;
  items: ImageDownloadProgressItem[];
}

export interface StoredJob {
  id: string;
  status: 'queued' | '排队中' | 'processing' | 'completed' | 'failed';
  mode: Mode;
  prompt: string;
  output_size: OutputSize;
  custom_size?: string;
  temperature: number;
  aspect_ratio: AspectRatio;
  model: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  created_at: string;
  error?: string;
  networkError?: boolean;
  /** true 表示后端明确判定该失败任务不可恢复（API 错误 / 服务器重启 / 已过期 / 已删除）。
   * 仅在 status==='failed' 时有意义；undefined 视为非终态，允许"查看进度" */
  terminal?: boolean;
  warning?: string;
  imageData?: string;
  parallelCount?: number;
  images?: string[];
  serverTaskId?: string;
  serverTaskAcked?: boolean;
  refImages?: RefImageData[];
  originalPrompt?: string;
  blobUrls?: string[];
  imageDownloadProgress?: ImageDownloadProgress;
}

const JOBS_KEY = 'nova-jobs';

/**
 * 任务历史最多保留的已完成记录数（进行中的任务永远保留）。
 * 无上限会让 localStorage 随使用无限增长；被淘汰的记录连同 IndexedDB 图片与 blob 一起清理。
 */
export const MAX_STORED_JOBS = 200;

function isActiveJobStatus(status: StoredJob['status']): boolean {
  return status === 'queued' || status === '排队中' || status === 'processing';
}

/** 淘汰超上限的已完成历史任务：返回保留列表，并异步清掉被淘汰任务的图片数据 */
function boundJobs(jobs: StoredJob[]): StoredJob[] {
  const active = jobs.filter(job => isActiveJobStatus(job.status));
  const settled = jobs
    .filter(job => !isActiveJobStatus(job.status))
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const keepCount = Math.max(0, MAX_STORED_JOBS - active.length);
  const kept = settled.slice(0, keepCount);
  const evicted = settled.slice(keepCount);
  if (evicted.length > 0) {
    for (const job of evicted) {
      void deleteImage(job.id).catch(() => undefined);
      // 不传 count：按 jobId 前缀删掉该任务的所有 blob
      void deleteStoredBlobs(job.id).catch(() => undefined);
    }
  }
  return [...active, ...kept];
}

// 复用单例连接层；保留这两个导出名以兼容现有调用方（如 useWorkspaceJobs）。
export { IMG_STORE };
export const openDB = openImageDb;

export function getImageSrc(imageData: string): string {
  if (imageData.startsWith('blob:')) {
    return imageData;
  }

  if (imageData.startsWith('URL:')) {
    return imageData.substring(4);
  }

  if (imageData.startsWith('MULTI_URL:')) {
    return imageData.substring(10).split('|||')[0];
  }

  if (imageData.startsWith('IDB:')) {
    return '';
  }

  return `data:image/png;base64,${imageData}`;
}

function toPersistedImageRefs(result: StoredJob): string[] | undefined {
  return result.images?.map((image, index) => (
    image.startsWith('blob:') ? makeStoredBlobRef(result.id, index) : image
  ));
}

export async function saveImage(result: StoredJob) {
  const db = await openDB();
  if (!db) return;

  const images = toPersistedImageRefs(result);

  return new Promise<void>((resolve) => {
    const tx = db.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).put({
      id: result.id,
      jobId: result.id,
      status: result.status,
      imageData: images?.[0] || result.imageData,
      images,
      refImages: result.refImages,
      error: result.error,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function deleteImage(jobId: string) {
  const db = await openDB();
  if (!db) return;

  return new Promise<void>((resolve) => {
    const tx = db.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).delete(jobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function loadJobs(): StoredJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: StoredJob[]) {
  if (typeof window === 'undefined') return;

  const bounded = boundJobs(jobs);
  const lightweight = bounded.map(({ ...job }) => {
    delete job.imageData;
    delete job.images;
    delete job.refImages;
    delete job.blobUrls;
    delete job.imageDownloadProgress;
    return job;
  });
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(lightweight));
  } catch {
    // Keep the in-memory job list usable when storage quota or browser policy blocks writes.
  }
}
