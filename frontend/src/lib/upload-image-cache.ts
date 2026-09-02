export interface PreparedUploadImage {
    id: string;
    name: string;
    preview: string;
    dataUrl: string;
    mimeType: string;
    originalSize: number;
    processedSize: number;
    width: number;
    height: number;
    cacheHit: boolean;
}

interface CachedUploadImage {
    key: string;
    name: string;
    mimeType: string;
    dataUrl: string;
    originalSize: number;
    processedSize: number;
    width: number;
    height: number;
    createdAt: number;
}

const DB_NAME = 'nova-upload-cache';
const DB_VERSION = 1;
const STORE_NAME = 'images';

// 单例缓存数据库连接（参考 image-db.ts 的模式），避免每次读写 open 后泄漏连接。
let uploadCacheDbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (uploadCacheDbPromise) return uploadCacheDbPromise;

    uploadCacheDbPromise = new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => { uploadCacheDbPromise = null; resolve(null); };
        request.onsuccess = () => {
            const db = request.result;
            // 另一个 tab 或备份导入触发版本变更时主动关闭并失效缓存，下次调用会重新打开。
            db.onversionchange = () => {
                try { db.close(); } catch { /* ignore */ }
                uploadCacheDbPromise = null;
            };
            db.onclose = () => { uploadCacheDbPromise = null; };
            resolve(db);
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
    });
    return uploadCacheDbPromise;
}

async function getCachedImage(key: string): Promise<CachedUploadImage | null> {
    const db = await openDB();
    if (!db) return null;

    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve((req.result as CachedUploadImage) || null);
        req.onerror = () => resolve(null);
    });
}

async function saveCachedImage(record: CachedUploadImage): Promise<void> {
    const db = await openDB();
    if (!db) return;

    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

function bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function hashFile(file: File): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return bufferToHex(digest);
}

function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
    });
}

function dataUrlToSize(dataUrl: string): number {
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    return Math.ceil((base64.length * 3) / 4);
}

async function canvasToDataUrl(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<string> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('图片导出失败'));
                return;
            }

            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        }, mimeType, quality);
    });
}

function getBestMimeType(fileType: string): 'image/png' | 'image/jpeg' | 'image/webp' {
    if (fileType === 'image/webp') return 'image/webp';
    if (fileType === 'image/png') return 'image/png';
    return 'image/jpeg';
}

const FAST_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
const MAX_OUTPUT_SIDE = 2560;
const MAX_OUTPUT_PIXELS = 5_000_000;
const JPEG_QUALITY = 0.86;
const WEBP_QUALITY = 0.9;

function getTargetDimensions(width: number, height: number): { width: number; height: number } {
    if (width <= 0 || height <= 0) {
        return { width: 1, height: 1 };
    }

    const sideScale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(width, height));
    const pixelScale = Math.min(1, Math.sqrt(MAX_OUTPUT_PIXELS / (width * height)));
    const scale = Math.min(sideScale, pixelScale);

    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function getFastOutputMimeType(inputMimeType: string): 'image/jpeg' | 'image/webp' {
    const normalized = inputMimeType.toLowerCase();
    if (normalized === 'image/png' || normalized === 'image/webp') {
        return 'image/webp';
    }
    return 'image/jpeg';
}

function yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function optimiseWithCanvasFallback(file: File, dataUrl: string): Promise<{ dataUrl: string; mimeType: string; width: number; height: number; processedSize: number }> {
    const img = await loadImageFromDataUrl(dataUrl);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return {
            dataUrl,
            mimeType: file.type || 'image/png',
            width,
            height,
            processedSize: file.size,
        };
    }

    ctx.drawImage(img, 0, 0);
    const outputMimeType = getBestMimeType(file.type);

    if (outputMimeType === 'image/jpeg') {
        return {
            dataUrl,
            mimeType: file.type || outputMimeType,
            width,
            height,
            processedSize: file.size,
        };
    }

    const fallbackDataUrl = await canvasToDataUrl(canvas, outputMimeType, outputMimeType === 'image/png' ? undefined : 0.98);

    return {
        dataUrl: fallbackDataUrl,
        mimeType: outputMimeType,
        width,
        height,
        processedSize: dataUrlToSize(fallbackDataUrl),
    };
}

async function optimizeImage(file: File): Promise<{ dataUrl: string; mimeType: string; width: number; height: number; processedSize: number }> {
    const originalDataUrl = await readFileAsDataUrl(file);
    const img = await loadImageFromDataUrl(originalDataUrl);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const mimeType = (file.type || '').toLowerCase();

    // 小图直接跳过压缩，优先响应速度。
    if (file.size <= FAST_COMPRESS_THRESHOLD_BYTES) {
        return {
            dataUrl: originalDataUrl,
            mimeType: file.type || mimeType || 'image/jpeg',
            width,
            height,
            processedSize: file.size,
        };
    }

    try {
        const { width: targetWidth, height: targetHeight } = getTargetDimensions(width, height);
        await yieldToMainThread();

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return {
                dataUrl: originalDataUrl,
                mimeType: file.type || 'application/octet-stream',
                width,
                height,
                processedSize: file.size,
            };
        }

        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        const outputMimeType = getFastOutputMimeType(mimeType);
        const quality = outputMimeType === 'image/webp' ? WEBP_QUALITY : JPEG_QUALITY;
        const compressedDataUrl = await canvasToDataUrl(canvas, outputMimeType, quality);
        const compressedSize = dataUrlToSize(compressedDataUrl);

        if (compressedSize >= file.size * 0.98) {
            return {
                dataUrl: originalDataUrl,
                mimeType: file.type || outputMimeType,
                width,
                height,
                processedSize: file.size,
            };
        }

        return {
            dataUrl: compressedDataUrl,
            mimeType: outputMimeType,
            width: targetWidth,
            height: targetHeight,
            processedSize: compressedSize,
        };
    } catch {
        return optimiseWithCanvasFallback(file, originalDataUrl);
    }
}

/**
 * Generate a display badge for an uploaded image.
 * Returns "缓存" when cache is hit, "-N%" when compression saved >= 5%,
 * and undefined when there's no meaningful saving to report.
 */
export function getOptimizationBadge(
  originalSize: number,
  processedSize: number,
  cacheHit: boolean,
): string | undefined {
  if (cacheHit) return '缓存';
  if (originalSize <= 0 || processedSize >= originalSize) return undefined;
  const savedPercent = Math.round((1 - processedSize / originalSize) * 100);
  return savedPercent >= 5 ? `-${savedPercent}%` : undefined;
}

export async function prepareUploadImage(file: File): Promise<PreparedUploadImage> {
    const key = await hashFile(file);
    const cached = await getCachedImage(key);

    if (cached) {
        return {
            id: key,
            name: cached.name || file.name,
            preview: cached.dataUrl,
            dataUrl: cached.dataUrl,
            mimeType: cached.mimeType,
            originalSize: cached.originalSize,
            processedSize: cached.processedSize,
            width: cached.width,
            height: cached.height,
            cacheHit: true,
        };
    }

    const optimized = await optimizeImage(file);
    const record: CachedUploadImage = {
        key,
        name: file.name,
        mimeType: optimized.mimeType,
        dataUrl: optimized.dataUrl,
        originalSize: file.size,
        processedSize: optimized.processedSize,
        width: optimized.width,
        height: optimized.height,
        createdAt: Date.now(),
    };

    await saveCachedImage(record);

    return {
        id: key,
        name: file.name,
        preview: optimized.dataUrl,
        dataUrl: optimized.dataUrl,
        mimeType: optimized.mimeType,
        originalSize: file.size,
        processedSize: optimized.processedSize,
        width: optimized.width,
        height: optimized.height,
        cacheHit: false,
    };
}