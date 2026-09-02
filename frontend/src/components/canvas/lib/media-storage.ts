"use client";

/**
 * 画布视频/音频素材节点的本地文件存储（纯前端 IndexedDB，不上传服务端）。
 *
 * 与图片分开一个 store：图片走 image-storage（`image:` 前缀），音视频体积大、
 * 生命周期不同，混在一起时图片侧的清理逻辑会误删这里的文件。
 * 键统一带 `media:` 前缀，导出/导入按前缀分流到对应 store。
 */

import localforage from "localforage";
import { nanoid } from "nanoid";

import { getMediaConfig, type MediaKind } from "@/lib/plugin-media-config";

export type StoredCanvasMedia = {
  url: string;
  storageKey: string;
  name: string;
  bytes: number;
  mimeType: string;
  /** 时长（秒）；元数据读不出来时为 undefined，界面不显示时长而不是显示 0 */
  durationSec?: number;
};

export const MEDIA_STORAGE_PREFIX = "media:";

const store = localforage.createInstance({ name: "nova-image", storeName: "canvas_media_files" });
const objectUrls = new Map<string, string>();

export function isMediaStorageKey(storageKey?: string): boolean {
  return Boolean(storageKey?.startsWith(MEDIA_STORAGE_PREFIX));
}

/** 存入一个本地音视频文件，返回可直接写进节点 metadata 的描述。 */
export async function storeCanvasMedia(file: File, kind: MediaKind): Promise<StoredCanvasMedia> {
  const storageKey = `${MEDIA_STORAGE_PREFIX}${nanoid()}`;
  await store.setItem(storageKey, file);
  const url = URL.createObjectURL(file);
  objectUrls.set(storageKey, url);
  const durationSec = await readMediaDuration(url, kind);
  return {
    url,
    storageKey,
    name: file.name,
    bytes: file.size,
    mimeType: file.type || getMediaConfig(kind).mimeTypes[0],
    durationSec,
  };
}

/** storageKey → 可播放地址。objectURL 在本次会话内复用，刷新后从 IndexedDB 重建。 */
export async function resolveMediaUrl(storageKey?: string, fallback = ""): Promise<string> {
  if (!storageKey) return fallback;
  const cached = objectUrls.get(storageKey);
  if (cached) return cached;
  const blob = await store.getItem<Blob>(storageKey);
  if (!blob) return fallback;
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

export async function getMediaBlob(storageKey: string): Promise<Blob | null> {
  return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob): Promise<string> {
  await store.setItem(storageKey, blob);
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

/** storageKey → File（上传给插件任务时用）。 */
export async function mediaToFile(storageKey: string, name: string, mimeType?: string): Promise<File> {
  const blob = await store.getItem<Blob>(storageKey);
  if (!blob) throw new Error(`素材「${name}」已丢失，请重新上传`);
  return new File([blob], name, { type: mimeType || blob.type || "application/octet-stream" });
}

export async function deleteStoredMedia(keys: Iterable<string>): Promise<void> {
  await Promise.all(
    Array.from(new Set(keys)).map(async (key) => {
      const url = objectUrls.get(key);
      if (url) URL.revokeObjectURL(url);
      objectUrls.delete(key);
      await store.removeItem(key);
    }),
  );
}

/** 读时长：交给浏览器解元数据；读不出来（编码不支持/jsdom）就当没有。 */
export function readMediaDuration(url: string, kind: MediaKind): Promise<number | undefined> {
  if (typeof document === "undefined" || kind === "images") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const element = document.createElement(kind === "audios" ? "audio" : "video");
    const done = (value?: number) => {
      element.onloadedmetadata = null;
      element.onerror = null;
      element.src = "";
      resolve(value);
    };
    element.preload = "metadata";
    element.onloadedmetadata = () => done(Number.isFinite(element.duration) ? element.duration : undefined);
    element.onerror = () => done(undefined);
    element.src = url;
    // 元数据迟迟不到位时不阻塞上传流程
    setTimeout(() => done(Number.isFinite(element.duration) ? element.duration : undefined), 4000);
  });
}
