import { openImageDb, BLOBS_STORE } from '@/lib/image-db';

const MAX_FALLBACK_STORE_SIZE = 50;

interface FallbackEntry {
  blob: Blob;
  lastAccess: number;
  ownerGeneration?: number;
}

const blobFallbackStore = new Map<string, FallbackEntry>();

function evictOldestIfNeeded() {
  if (blobFallbackStore.size <= MAX_FALLBACK_STORE_SIZE) return;
  // 找到最久未访问的条目并删除
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of blobFallbackStore) {
    if (entry.lastAccess < oldestTime) {
      oldestTime = entry.lastAccess;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) {
    blobFallbackStore.delete(oldestKey);
  }
}

export function getFallbackBlob(key: string): Blob | undefined {
  const entry = blobFallbackStore.get(key);
  if (!entry) return undefined;
  entry.lastAccess = Date.now();
  return entry.blob;
}

export function setFallbackBlob(key: string, blob: Blob, ownerGeneration?: number): void {
  // 如果 key 已存在则更新，否则先淘汰旧条目
  if (!blobFallbackStore.has(key)) {
    evictOldestIfNeeded();
  }
  blobFallbackStore.set(key, { blob, lastAccess: Date.now(), ownerGeneration });
}


export function makeStoredBlobRef(jobId: string, imageIndex: number): string {
  return `IDB:${jobId}-${imageIndex}`;
}

export function parseStoredBlobRef(ref: string): { jobId: string; imageIndex: number } | null {
  if (!ref.startsWith('IDB:')) return null;

  const key = ref.substring(4);
  const separatorIndex = key.lastIndexOf('-');
  if (separatorIndex <= 0) return null;

  const imageIndex = Number(key.substring(separatorIndex + 1));
  if (!Number.isInteger(imageIndex) || imageIndex < 0) return null;

  return {
    jobId: key.substring(0, separatorIndex),
    imageIndex,
  };
}

export type ImageDownloadStatus = 'pending' | 'downloading' | 'cached' | 'failed';

export interface ImageDownloadProgressItem {
  index: number;
  status: ImageDownloadStatus;
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
}

export type ImageDownloadProgressHandler = (item: ImageDownloadProgressItem) => void;

interface BlobDownloadProgress {
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
}

type BlobDownloadProgressHandler = (progress: BlobDownloadProgress) => void;

// 这是“无进展”超时，不是总墙钟超时。4K 大图只要持续有 body chunk 到达，
// 就会不断续期，避免慢网络下大文件被固定 120s 总时长误杀。
const IMAGE_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getPercent(loadedBytes: number, totalBytes?: number): number | undefined {
  if (!totalBytes || totalBytes <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((loadedBytes / totalBytes) * 100)));
}

function createIdleTimeout(controller: AbortController): { reset: () => void; clear: () => void } {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const reset = () => {
    clear();
    timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  return { reset, clear };
}

async function readResponseAsBlob(
  response: Response,
  onProgress?: BlobDownloadProgressHandler,
): Promise<Blob> {
  const totalBytes = parseContentLength(response.headers.get('content-length'));
  const contentType = response.headers.get('content-type') || 'image/png';

  if (!response.body) {
    const blob = await response.blob();
    onProgress?.({
      loadedBytes: blob.size,
      totalBytes: totalBytes || blob.size || undefined,
      percent: getPercent(blob.size, totalBytes || blob.size || undefined),
    });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loadedBytes = 0;
  onProgress?.({ loadedBytes, totalBytes, percent: getPercent(loadedBytes, totalBytes) });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = new Uint8Array(value.byteLength);
    chunk.set(value);
    chunks.push(chunk.buffer);
    loadedBytes += value.byteLength;
    onProgress?.({ loadedBytes, totalBytes, percent: getPercent(loadedBytes, totalBytes) });
  }

  return new Blob(chunks, { type: contentType });
}

export async function fetchImageAsBlob(
  url: string,
  maxRetries = 2,
  onProgress?: BlobDownloadProgressHandler,
): Promise<Blob> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const idleTimeout = createIdleTimeout(controller);
    try {
      idleTimeout.reset();
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      idleTimeout.reset();
      const blob = await readResponseAsBlob(response, progress => {
        idleTimeout.reset();
        onProgress?.(progress);
      });
      return blob;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(getErrorMessage(error));
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    } finally {
      idleTimeout.clear();
    }
  }
  throw lastError || new Error('图片下载失败');
}

async function storeImageBlobInternal(
  jobId: string,
  imageIndex: number,
  blob: Blob,
  shouldStore: () => boolean,
  ownerGeneration?: number,
): Promise<void> {
  const db = await openImageDb();
  if (!shouldStore()) return;
  if (!db) {
    setFallbackBlob(`${jobId}-${imageIndex}`, blob, ownerGeneration);
    return;
  }

  return new Promise<void>((resolve) => {
    const tx = db.transaction(BLOBS_STORE, 'readwrite');
    tx.objectStore(BLOBS_STORE).put({
      key: `${jobId}-${imageIndex}`,
      jobId,
      imageIndex,
      blob,
      createdAt: Date.now(),
      ownerGeneration,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      if (shouldStore()) setFallbackBlob(`${jobId}-${imageIndex}`, blob, ownerGeneration);
      resolve();
    };
  });
}

export async function storeImageBlob(
  jobId: string,
  imageIndex: number,
  blob: Blob,
  shouldStore: () => boolean = () => true,
  ownerGeneration?: number,
): Promise<void> {
  return storeImageBlobInternal(jobId, imageIndex, blob, shouldStore, ownerGeneration);
}

export async function getStoredBlob(jobId: string, imageIndex: number): Promise<Blob | null> {
  const fallbackKey = `${jobId}-${imageIndex}`;
  const fallback = getFallbackBlob(fallbackKey);
  if (fallback) return fallback;

  const db = await openImageDb();
  if (!db) return null;

  return new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(BLOBS_STORE, 'readonly');
    const req = tx.objectStore(BLOBS_STORE).get(`${jobId}-${imageIndex}`);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror = () => resolve(null);
  });
}


export async function resolveStoredImageRef(
  jobId: string,
  image: string,
  imageIndex: number
): Promise<{ image: string; blobUrl?: string }> {
  const storedRef = parseStoredBlobRef(image);
  const blob = storedRef
    ? await getStoredBlob(storedRef.jobId, storedRef.imageIndex)
    : image.startsWith('blob:')
      ? await getStoredBlob(jobId, imageIndex)
      : null;

  if (!blob) return { image };

  const blobUrl = URL.createObjectURL(blob);
  return { image: blobUrl, blobUrl };
}

export async function resolveStoredImageRefs(jobId: string, images: string[]): Promise<{ images: string[]; blobUrls: string[] }> {
  const resolved = await Promise.all(images.map((image, index) => resolveStoredImageRef(jobId, image, index)));
  return {
    images: resolved.map(item => item.image),
    blobUrls: resolved.flatMap(item => item.blobUrl ? [item.blobUrl] : []),
  };
}

export async function deleteStoredBlobIfOwner(
  jobId: string,
  imageIndex: number,
  ownerGeneration: number,
): Promise<void> {
  const key = `${jobId}-${imageIndex}`;
  const fallback = blobFallbackStore.get(key);
  if (fallback?.ownerGeneration === ownerGeneration) blobFallbackStore.delete(key);

  const db = await openImageDb();
  if (!db || !db.objectStoreNames.contains(BLOBS_STORE)) return;
  return new Promise<void>((resolve) => {
    const tx = db.transaction(BLOBS_STORE, 'readwrite');
    const store = tx.objectStore(BLOBS_STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result?.ownerGeneration === ownerGeneration) store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function deleteStoredBlobs(jobId: string, imageCount?: number): Promise<void> {
  const fallbackPrefix = `${jobId}-`;
  for (const key of Array.from(blobFallbackStore.keys())) {
    if (key.startsWith(fallbackPrefix)) {
      blobFallbackStore.delete(key);
    }
  }

  const db = await openImageDb();
  if (!db || !db.objectStoreNames.contains(BLOBS_STORE)) return;

  return new Promise<void>((resolve) => {
    const tx = db.transaction(BLOBS_STORE, 'readwrite');
    const store = tx.objectStore(BLOBS_STORE);

    if (typeof imageCount === 'number') {
      for (let index = 0; index < imageCount; index++) {
        store.delete(`${jobId}-${index}`);
      }
    } else {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key.startsWith(fallbackPrefix)) {
          cursor.delete();
        }
        cursor.continue();
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * 清扫 Agent 命名空间的孤儿 blob：登记记录已不存在（生成中断、旧版本残留），
 * 但字节仍留在 blobs store 里，会把备份包越撑越大。
 * 只处理 Agent 自己的 key（默认会话 `img_N-x`、其他会话 `agent-session-<sid>-img_N-x`），
 * 任务结果等 uuid key 一律不动。返回删除的 blob 数。
 */
export async function deleteUnreferencedAgentBlobs(validJobIds: ReadonlySet<string>): Promise<number> {
  const isAgentKey = (key: string) => /^img_\d+-\d+$/.test(key) || key.startsWith('agent-session-');
  let removed = 0;
  for (const key of Array.from(blobFallbackStore.keys())) {
    if (!isAgentKey(key)) continue;
    const jobId = key.slice(0, key.lastIndexOf('-'));
    if (!validJobIds.has(jobId)) {
      blobFallbackStore.delete(key);
      removed++;
    }
  }

  const db = await openImageDb();
  if (!db || !db.objectStoreNames.contains(BLOBS_STORE)) return removed;

  const keys = await new Promise<string[]>((resolve) => {
    const tx = db.transaction(BLOBS_STORE, 'readonly');
    const request = tx.objectStore(BLOBS_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.map(String));
    request.onerror = () => resolve([]);
  });
  const orphans = keys.filter(key => {
    if (!isAgentKey(key)) return false;
    const jobId = key.slice(0, key.lastIndexOf('-'));
    return !validJobIds.has(jobId);
  });
  if (orphans.length === 0) return removed;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(BLOBS_STORE, 'readwrite');
    const store = tx.objectStore(BLOBS_STORE);
    for (const key of orphans) store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  return removed + orphans.length;
}

export interface DownloadResult {
  successCount: number;
  failCount: number;
  blobUrls: string[];
  items: ImageDownloadProgressItem[];
}

export interface DownloadAndStoreImagesOptions {
  maxRetries?: number;
  onProgress?: ImageDownloadProgressHandler;
}

function createInitialDownloadItems(imageRefs: string[]): ImageDownloadProgressItem[] {
  return imageRefs.map((ref, index) => ({
    index,
    status: ref.startsWith('URL:') ? 'pending' : 'cached',
    loadedBytes: 0,
  }));
}

function updateDownloadItem(
  items: ImageDownloadProgressItem[],
  nextItem: ImageDownloadProgressItem,
): void {
  items[nextItem.index] = { ...items[nextItem.index], ...nextItem };
}

export async function downloadAndStoreImages(
  jobId: string,
  imageRefs: string[],
  options: DownloadAndStoreImagesOptions = {},
): Promise<DownloadResult> {
  let successCount = 0;
  let failCount = 0;
  const blobUrls: string[] = new Array(imageRefs.length).fill('');
  const items = createInitialDownloadItems(imageRefs);

  const tasks = imageRefs.map(async (ref, i) => {
    if (!ref.startsWith('URL:')) return;
    const url = ref.substring(4);
    const emit = (item: ImageDownloadProgressItem) => {
      updateDownloadItem(items, item);
      options.onProgress?.(items[item.index]);
    };
    try {
      emit({ index: i, status: 'downloading', loadedBytes: 0 });
      const blob = await fetchImageAsBlob(url, options.maxRetries ?? 2, progress => {
        emit({ index: i, status: 'downloading', ...progress });
      });
      await storeImageBlob(jobId, i, blob);
      blobUrls[i] = URL.createObjectURL(blob);
      successCount++;
      const totalBytes = items[i]?.totalBytes || blob.size || undefined;
      emit({
        index: i,
        status: 'cached',
        loadedBytes: blob.size,
        totalBytes,
        percent: getPercent(blob.size, totalBytes),
      });
    } catch (error) {
      failCount++;
      emit({
        index: i,
        status: 'failed',
        loadedBytes: items[i]?.loadedBytes || 0,
        totalBytes: items[i]?.totalBytes,
        percent: items[i]?.percent,
        error: getErrorMessage(error),
      });
    }
  });

  await Promise.allSettled(tasks);
  return { successCount, failCount, blobUrls, items };
}

export function revokeBlobUrls(blobUrls: string[]): void {
  for (const url of blobUrls) {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
}
