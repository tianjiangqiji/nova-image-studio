'use client';

import { addImageAsset, findImageAssetByBlob, getAssetBlob, getAssetFileExtension, touchImageAsset, type AssetSourceKind, type ImageAsset } from '@/lib/asset-store';
import { getAgentImageBytes } from '@/lib/agent-context-store';
import { getImageSrc, type RefImageData } from '@/lib/job-store';
import { getStoredBlob } from '@/lib/image-downloader';
import { getOptimizationBadge, prepareUploadImage } from '@/lib/upload-image-cache';

export interface ImageActionPayload {
  id?: string;
  name?: string;
  src?: string;
  dataUrl?: string;
  blob?: Blob;
  file?: File;
  assetId?: string;
  agentImageId?: string;
  /** Agent 图片所属会话，避免相同 imgId 在不同会话间串读。 */
  sessionId?: string;
  storedRef?: {
    jobId: string;
    imageRef: string;
    imageIndex: number;
  };
  mimeType?: string;
  sourceKind: AssetSourceKind;
  sourceLabel?: string;
  sourceRef?: string;
  prompt?: string;
  note?: string;
}

export interface ImageActionToastDetail {
  message: string;
  type: 'success' | 'error' | 'info';
}

export interface UseAsImageReferenceDetail {
  refImages: RefImageData[];
  prompt?: string;
}

const TOAST_EVENT = 'nova-image-action-toast';
const USE_AS_REFERENCE_EVENT = 'nova-use-as-i2i-reference';

export function dispatchImageActionToast(message: string, type: ImageActionToastDetail['type'] = 'info'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ImageActionToastDetail>(TOAST_EVENT, { detail: { message, type } }));
}

export function subscribeImageActionToasts(handler: (detail: ImageActionToastDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => handler((event as CustomEvent<ImageActionToastDetail>).detail);
  window.addEventListener(TOAST_EVENT, listener);
  return () => window.removeEventListener(TOAST_EVENT, listener);
}

export function subscribeUseAsImageReference(handler: (detail: UseAsImageReferenceDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => handler((event as CustomEvent<UseAsImageReferenceDetail>).detail);
  window.addEventListener(USE_AS_REFERENCE_EVENT, listener);
  return () => window.removeEventListener(USE_AS_REFERENCE_EVENT, listener);
}

function makeId(prefix = 'ref'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stripImageRef(ref: string): string {
  if (ref.startsWith('URL:') || ref.startsWith('MULTI_URL:') || ref.startsWith('IDB:') || ref.startsWith('blob:')) {
    return getImageSrc(ref) || ref;
  }
  if (ref.startsWith('data:') || /^https?:\/\//i.test(ref) || ref.startsWith('/')) return ref;
  return `data:image/png;base64,${ref}`;
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

import { MAX_UPLOAD_SIZE_BYTES as MAX_REFERENCE_UPLOAD_SIZE_BYTES } from '@/lib/constants';

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function getClipboardImageBlob(blob: Blob): Promise<Blob> {
  const mimeType = blob.type || 'image/png';
  const clipboardItem = ClipboardItem as unknown as { supports?: (type: string) => boolean };
  const supportsType = typeof clipboardItem.supports === 'function'
    ? clipboardItem.supports(mimeType)
    : mimeType === 'image/png';
  if (supportsType) return blob;
  if (!mimeType.startsWith('image/')) {
    throw new Error('当前文件不是可复制的图片格式');
  }
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持复制图片');
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('图片尺寸读取失败');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持复制图片');
    ctx.drawImage(img, 0, 0);
    const pngBlob = await canvasToPngBlob(canvas);
    if (!pngBlob) throw new Error('图片格式转换失败');
    return pngBlob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function touchAssetSilently(assetId?: string): void {
  if (!assetId) return;
  void touchImageAsset(assetId).catch(() => {});
}

async function resolveStoredRefToBlob(payload: ImageActionPayload): Promise<Blob | null> {
  const ref = payload.storedRef;
  if (!ref) return null;
  if (ref.imageRef.startsWith('IDB:')) {
    const key = ref.imageRef.substring(4);
    const separatorIndex = key.lastIndexOf('-');
    if (separatorIndex > 0) {
      const jobId = key.substring(0, separatorIndex);
      const imageIndex = Number(key.substring(separatorIndex + 1));
      if (Number.isInteger(imageIndex)) {
        return getStoredBlob(jobId, imageIndex);
      }
    }
  }
  if (ref.imageRef.startsWith('blob:')) {
    const stored = await getStoredBlob(ref.jobId, ref.imageIndex);
    if (stored) return stored;
  }
  const src = stripImageRef(ref.imageRef);
  if (src.startsWith('data:')) return dataUrlToBlob(src);
  if (src) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }
  return null;
}

export async function resolveImagePayloadToBlob(payload: ImageActionPayload): Promise<Blob> {
  if (payload.blob) return payload.blob;
  if (payload.file) return payload.file;
  if (payload.assetId) {
    const blob = await getAssetBlob(payload.assetId);
    if (blob) return blob;
  }
  if (payload.agentImageId) {
    const blob = await getAgentImageBytes(payload.agentImageId, payload.sessionId);
    if (blob) return blob;
  }
  const stored = await resolveStoredRefToBlob(payload);
  if (stored) return stored;
  if (payload.dataUrl) return dataUrlToBlob(payload.dataUrl);
  if (payload.src) {
    if (payload.src.startsWith('data:')) return dataUrlToBlob(payload.src);
    const src = stripImageRef(payload.src);
    if (src.startsWith('data:')) return dataUrlToBlob(src);
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }
  throw new Error('无法读取图片');
}

function getDownloadName(payload: ImageActionPayload, blob: Blob): string {
  const rawName = payload.name?.trim() || payload.id || payload.assetId || payload.agentImageId || `nova-image-${Date.now()}`;
  const baseName = rawName.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'nova-image';
  const ext = getAssetFileExtension(blob.type || payload.mimeType || 'image/png');
  return baseName.toLowerCase().endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;
}

export async function downloadImagePayload(payload: ImageActionPayload): Promise<void> {
  const blob = await resolveImagePayloadToBlob(payload);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = getDownloadName(payload, blob);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  touchAssetSilently(payload.assetId);
}

export async function copyImagePayload(payload: ImageActionPayload): Promise<void> {
  const blob = await resolveImagePayloadToBlob(payload);
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('当前浏览器不支持复制图片');
  }
  const clipboardBlob = await getClipboardImageBlob(blob);
  await navigator.clipboard.write([new ClipboardItem({ [clipboardBlob.type || 'image/png']: clipboardBlob })]);
  touchAssetSilently(payload.assetId);
}

export async function addImagePayloadToAssets(payload: ImageActionPayload): Promise<{ asset: ImageAsset; alreadyExists: boolean }> {
  const blob = await resolveImagePayloadToBlob(payload);
  const existingAsset = await findImageAssetByBlob(blob);
  if (existingAsset) {
    await touchImageAsset(existingAsset.id);
    return { asset: existingAsset, alreadyExists: true };
  }
  const asset = await addImageAsset({
    blob,
    name: payload.name,
    sourceKind: payload.sourceKind,
    sourceLabel: payload.sourceLabel,
    sourceRef: payload.sourceRef || payload.id || payload.assetId || payload.agentImageId,
    prompt: payload.prompt,
    note: payload.note,
  });
  return { asset, alreadyExists: false };
}

export async function applyImagePayloadAsReference(payload: ImageActionPayload): Promise<void> {
  const blob = await resolveImagePayloadToBlob(payload);
  const fileName = payload.name || payload.id || '素材参考图';
  const file = blob instanceof File
    ? blob
    : new File([blob], fileName, { type: blob.type || payload.mimeType || 'image/png' });
  const optimized = await prepareUploadImage(file);
  if (optimized.processedSize > MAX_REFERENCE_UPLOAD_SIZE_BYTES) {
    throw new Error(`${fileName} 压缩后仍超过 10MB，无法作为图生图参考`);
  }
  const refImage: RefImageData = {
    id: makeId('asset-ref'),
    name: optimized.name || fileName,
    dataUrl: optimized.dataUrl,
    mimeType: optimized.mimeType,
    badge: getOptimizationBadge(optimized.originalSize, optimized.processedSize, optimized.cacheHit),
  };
  touchAssetSilently(payload.assetId);
  window.dispatchEvent(new CustomEvent<UseAsImageReferenceDetail>(USE_AS_REFERENCE_EVENT, {
    detail: { refImages: [refImage] },
  }));
}

/**
 * 将标注后的图片（dataURL）连同构造好的提示词一起作为图生图参考发送到生图工作台。
 * 用于画笔标注编辑器：用户在图片上圈选区域并输入需求后，调用此函数跳转工作台。
 */
export async function applyAnnotatedImageAsReference(
  dataUrl: string,
  prompt: string,
  options?: { name?: string; badge?: string },
): Promise<void> {
  const file = new File(
    [dataUrlToBlob(dataUrl)],
    options?.name || '标注图片.png',
    { type: 'image/png' },
  );
  const optimized = await prepareUploadImage(file);
  if (optimized.processedSize > MAX_REFERENCE_UPLOAD_SIZE_BYTES) {
    throw new Error('标注图片压缩后仍超过 10MB，无法作为图生图参考');
  }
  const refImage: RefImageData = {
    id: makeId('anno-ref'),
    name: optimized.name || options?.name || '标注图片',
    dataUrl: optimized.dataUrl,
    mimeType: optimized.mimeType,
    badge: options?.badge || '标注',
  };
  window.dispatchEvent(new CustomEvent<UseAsImageReferenceDetail>(USE_AS_REFERENCE_EVENT, {
    detail: { refImages: [refImage], prompt },
  }));
}

export async function runImageAction(
  action: 'download' | 'copy' | 'add-to-assets' | 'use-as-reference',
  payload: ImageActionPayload,
): Promise<void> {
  try {
    if (action === 'download') {
      await downloadImagePayload(payload);
      dispatchImageActionToast('图片已开始下载', 'success');
      return;
    }
    if (action === 'copy') {
      await copyImagePayload(payload);
      dispatchImageActionToast('图片已复制', 'success');
      return;
    }
    if (action === 'add-to-assets') {
      const result = await addImagePayloadToAssets(payload);
      dispatchImageActionToast(result.alreadyExists ? '素材库已包含此图片' : '已添加到素材库', result.alreadyExists ? 'info' : 'success');
      return;
    }
    await applyImagePayloadAsReference(payload);
    dispatchImageActionToast('已添加为图生图参考', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : '图片操作失败';
    dispatchImageActionToast(message.includes('Failed to fetch') ? '该图片源不允许本地保存或复制，请直接右键/长摁复制' : message, 'error');
  }
}
