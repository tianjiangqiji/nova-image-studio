"use client";

/**
 * 编排节点（视频模式）的内存素材 store：本地上传的视频/音频/首尾帧文件。
 *
 * 为什么是模块级单例而不是组件状态：配置面板负责收集文件，生成服务负责消费，
 * 两者在画布下没有共同的状态容器（与宿主 plugin-upload-runner 同一套模式）。
 *
 * File 只在内存里（localStorage/IndexedDB 存不了），刷新即丢、绝不持久化；
 * previewUrl 的生命周期由 store 托管：素材被移除时统一 revoke，调用方不用管。
 */

import type { MediaKind } from "@/lib/plugin-schema";

/** 素材挂在插件的哪个字段上（ui.schema 里的 field.key，如 firstFrame/multiVideo）。 */
export type CanvasPendingMedia = {
  id: string;
  /** 所属素材字段的 key */
  slot: string;
  kind: MediaKind;
  file: File;
  /** URL.createObjectURL 本地预览地址，由 store 在移除时统一 revoke */
  previewUrl: string;
};

interface MediaEntry {
  items: CanvasPendingMedia[];
  /** 对外只读快照。useSyncExternalStore 要求 getSnapshot 在数据未变时返回同一个
   * 引用，否则每次渲染都被判定为「外部状态已变」而陷入无限重渲染。 */
  snapshot: CanvasPendingMedia[];
}

/** 无数据时返回的稳定空数组引用（跨节点共享，保证 toBe 相等）。 */
const EMPTY_SNAPSHOT: CanvasPendingMedia[] = [];

const entries = new Map<string, MediaEntry>();
const listeners = new Map<string, Set<() => void>>();

function notify(configNodeId: string): void {
  for (const listener of listeners.get(configNodeId) ?? []) {
    try {
      listener();
    } catch (error) {
      console.error("[canvas-video-media-store] error notifying listener", error);
    }
  }
}

export function getPendingMedia(configNodeId: string): CanvasPendingMedia[] {
  return entries.get(configNodeId)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function setPendingMedia(configNodeId: string, items: CanvasPendingMedia[]): void {
  const entry = entries.get(configNodeId);
  const previous = entry?.items ?? [];

  // 内容完全一致（逐项同引用）视为未变：不换快照、不通知
  if (previous.length === items.length && items.every((item, idx) => item === previous[idx])) {
    return;
  }

  // 被移除的素材（新列表里找不到同 id 同 previewUrl 的项）要 revoke 预览地址
  for (const old of previous) {
    if (!items.some(next => next.id === old.id && next.previewUrl === old.previewUrl)) {
      URL.revokeObjectURL(old.previewUrl);
    }
  }

  if (items.length === 0) {
    entries.delete(configNodeId);
  } else {
    entries.set(configNodeId, { items, snapshot: items.slice() });
  }
  notify(configNodeId);
}

export function clearPendingMedia(configNodeId: string): void {
  const entry = entries.get(configNodeId);
  if (!entry) return;
  for (const item of entry.items) {
    URL.revokeObjectURL(item.previewUrl);
  }
  entries.delete(configNodeId);
  notify(configNodeId);
}

export function subscribePendingMedia(configNodeId: string, listener: () => void): () => void {
  let set = listeners.get(configNodeId);
  if (!set) {
    set = new Set();
    listeners.set(configNodeId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(configNodeId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(configNodeId);
  };
}

export function __resetCanvasVideoMediaStoreForTests(): void {
  entries.clear();
  listeners.clear();
}
