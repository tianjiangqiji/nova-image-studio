import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetCanvasVideoMediaStoreForTests,
  clearPendingMedia,
  getPendingMedia,
  setPendingMedia,
  subscribePendingMedia,
  type CanvasPendingMedia,
} from "../../components/canvas/lib/canvas-video-media-store";
import {
  __resetCanvasUploadStoreForTests,
  clearUploadProgress,
  getUploadProgress,
  initUploadProgress,
  subscribeUploadProgress,
  updateUploadProgress,
  type CanvasUploadItemProgress,
} from "../../components/canvas/lib/canvas-video-upload-store";

/** jsdom 没实现 blob URL API，revokeObjectURL 的调用要靠 stub 捕获。 */
const revokeSpy = vi.fn();

function makeMedia(id: string, slot = "multi-video"): CanvasPendingMedia {
  const file = new File([new Uint8Array(1)], `${id}.mp4`, { type: "video/mp4" });
  return { id, slot, kind: "videos", file, previewUrl: `blob:${id}` };
}

function makeUploadItem(id: string, bytes = 1000): CanvasUploadItemProgress {
  return { id, name: `${id}.mp4`, kind: "videos", bytes, loaded: 0, status: "pending" };
}

beforeEach(() => {
  revokeSpy.mockClear();
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:${Math.random()}`),
    revokeObjectURL: revokeSpy,
  });
  __resetCanvasVideoMediaStoreForTests();
  __resetCanvasUploadStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCanvasVideoMediaStoreForTests();
  __resetCanvasUploadStoreForTests();
});

describe("canvas-video-media-store", () => {
  it("set 后 get 能读回素材内容（含 file 与 previewUrl 引用）", () => {
    const a = makeMedia("a");
    const b = makeMedia("b", "multi-audio");
    setPendingMedia("config-1", [a, b]);

    const items = getPendingMedia("config-1");
    expect(items).toHaveLength(2);
    expect(items[0]).toBe(a);
    expect(items[1]).toBe(b);
    expect(items[0].file).toBe(a.file);
    expect(items[1].slot).toBe("multi-audio");
  });

  it("无数据时返回稳定空数组引用", () => {
    // useSyncExternalStore 依赖这个契约：数据没变时必须返回同一个引用，否则无限重渲染
    expect(getPendingMedia("config-1")).toBe(getPendingMedia("config-1"));
    expect(getPendingMedia("config-1")).toBe(getPendingMedia("config-2"));
    expect(getPendingMedia("config-1")).toEqual([]);
  });

  it("数据未变时返回同一引用，数据变化后返回新引用", () => {
    const a = makeMedia("a");
    setPendingMedia("config-1", [a]);
    const first = getPendingMedia("config-1");
    expect(getPendingMedia("config-1")).toBe(first);

    setPendingMedia("config-1", [a, makeMedia("b")]);
    const afterAdd = getPendingMedia("config-1");
    expect(afterAdd).not.toBe(first);
    expect(afterAdd).toHaveLength(2);
    expect(getPendingMedia("config-1")).toBe(afterAdd);
  });

  it("移除素材时 revoke 其预览地址，保留项不 revoke", () => {
    const a = makeMedia("a");
    const b = makeMedia("b");
    setPendingMedia("config-1", [a, b]);

    setPendingMedia("config-1", [b]);

    expect(getPendingMedia("config-1")).toEqual([b]);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith("blob:a");
  });

  it("clearPendingMedia 全量清空并 revoke 所有预览地址", () => {
    setPendingMedia("config-1", [makeMedia("a"), makeMedia("b")]);

    clearPendingMedia("config-1");

    expect(getPendingMedia("config-1")).toEqual([]);
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });

  it("订阅与退订：变化时通知，退订后不再通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingMedia("config-1", listener);

    setPendingMedia("config-1", [makeMedia("a")]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setPendingMedia("config-1", [makeMedia("b")]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("set 相同引用列表不通知", () => {
    const items = [makeMedia("a")];
    setPendingMedia("config-1", items);
    const listener = vi.fn();
    subscribePendingMedia("config-1", listener);

    setPendingMedia("config-1", [...items]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("canvas-video-upload-store", () => {
  it("init 后 get 能读回快照（拷贝，不与内部条目同引用）", () => {
    initUploadProgress("node-1", [makeUploadItem("a")]);

    const snapshot = getUploadProgress("node-1");
    expect(snapshot).toEqual([expect.objectContaining({ id: "a", status: "pending" })]);
    expect(snapshot?.[0]).not.toBe(makeUploadItem("a"));
  });

  it("无数据返回 null（useSyncExternalStore 兼容）", () => {
    expect(getUploadProgress("node-1")).toBeNull();
  });

  it("update 逐项打补丁并通知订阅者", () => {
    const listener = vi.fn();
    subscribeUploadProgress("node-1", listener);
    initUploadProgress("node-1", [makeUploadItem("a")]);
    listener.mockClear();

    updateUploadProgress("node-1", "a", { status: "uploading", loaded: 500 });

    const snapshot = getUploadProgress("node-1");
    expect(snapshot?.[0]).toMatchObject({ status: "uploading", loaded: 500 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("update 不存在的条目/节点是空操作", () => {
    expect(() => updateUploadProgress("node-1", "a", { status: "done" })).not.toThrow();
  });

  it("clear 清空数据并通知订阅者", () => {
    const listener = vi.fn();
    initUploadProgress("node-1", [makeUploadItem("a")]);
    subscribeUploadProgress("node-1", listener);
    listener.mockClear();

    clearUploadProgress("node-1");

    expect(getUploadProgress("node-1")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("未初始化的节点 clear 不通知", () => {
    const listener = vi.fn();
    subscribeUploadProgress("node-1", listener);

    clearUploadProgress("node-1");

    expect(listener).not.toHaveBeenCalled();
  });
});
