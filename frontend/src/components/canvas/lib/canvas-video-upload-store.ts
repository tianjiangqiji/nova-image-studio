"use client";

/**
 * 视频生成的上传进度 store（按结果视频节点 ID 键控）。
 *
 * 素材上传发生在画布生成视频期间：进度条挂在结果视频节点上，而真正驱动上传的
 * 是生成服务，两者没有共同的状态容器，所以走模块级 store（与宿主
 * plugin-upload-runner 同一套稳定快照模式）。
 */

import type { MediaKind } from "@/lib/plugin-schema";

export type CanvasUploadItemStatus = "pending" | "uploading" | "done" | "failed";

export type CanvasUploadItemProgress = {
  id: string;
  name: string;
  kind: MediaKind;
  bytes: number;
  loaded: number;
  status: CanvasUploadItemStatus;
  error?: string;
};

interface UploadEntry {
  items: CanvasUploadItemProgress[];
  /** 对外只读快照。useSyncExternalStore 要求 getSnapshot 在数据未变时返回同一个
   * 引用，否则每次渲染都被判定为「外部状态已变」而陷入无限重渲染。 */
  snapshot: CanvasUploadItemProgress[];
}

const entries = new Map<string, UploadEntry>();
const listeners = new Map<string, Set<() => void>>();

function emit(nodeId: string): void {
  const entry = entries.get(nodeId);
  if (!entry) return;
  entry.snapshot = entry.items.map(item => ({ ...item }));
  for (const listener of listeners.get(nodeId) ?? []) {
    try {
      listener();
    } catch (error) {
      console.error("[canvas-video-upload-store] error notifying listener", error);
    }
  }
}

/** 初始化（或重置）某节点的上传条目列表（全 pending）。 */
export function initUploadProgress(nodeId: string, items: CanvasUploadItemProgress[]): void {
  entries.set(nodeId, { items, snapshot: items.map(item => ({ ...item })) });
  emit(nodeId);
}

export function updateUploadProgress(
  nodeId: string,
  itemId: string,
  patch: Partial<Omit<CanvasUploadItemProgress, "id">>,
): void {
  const entry = entries.get(nodeId);
  const item = entry?.items.find(candidate => candidate.id === itemId);
  if (!entry || !item) return;
  Object.assign(item, patch);
  emit(nodeId);
}

/** 稳定快照；无数据返回 null。useSyncExternalStore 兼容：数据未变返回同一引用。 */
export function getUploadProgress(nodeId: string): CanvasUploadItemProgress[] | null {
  return entries.get(nodeId)?.snapshot ?? null;
}

export function subscribeUploadProgress(nodeId: string, listener: () => void): () => void {
  let set = listeners.get(nodeId);
  if (!set) {
    set = new Set();
    listeners.set(nodeId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(nodeId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(nodeId);
  };
}

export function clearUploadProgress(nodeId: string): void {
  if (!entries.delete(nodeId)) return;
  for (const listener of listeners.get(nodeId) ?? []) {
    try {
      listener();
    } catch (error) {
      console.error("[canvas-video-upload-store] error notifying listener", error);
    }
  }
}

export function __resetCanvasUploadStoreForTests(): void {
  entries.clear();
  listeners.clear();
}
