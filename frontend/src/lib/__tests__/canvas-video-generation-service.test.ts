import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploadPluginMediaMock = vi.hoisted(() => vi.fn());
const createPluginTaskMock = vi.hoisted(() => vi.fn());
const getPluginTaskMock = vi.hoisted(() => vi.fn());
const ackPluginTaskMock = vi.hoisted(() => vi.fn());
const getPluginCredentialMock = vi.hoisted(() => vi.fn());
const imageToDataUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/plugin-task-client", () => ({
  uploadPluginMedia: uploadPluginMediaMock,
  createPluginTask: createPluginTaskMock,
  getPluginTask: getPluginTaskMock,
  ackPluginTask: ackPluginTaskMock,
}));

vi.mock("@/lib/plugin-registry-client", () => ({
  getPluginCredential: getPluginCredentialMock,
}));

vi.mock("../../components/canvas/lib/image-storage", () => ({
  imageToDataUrl: imageToDataUrlMock,
}));

vi.mock("../../components/canvas/canvas-generation-service", () => ({
  CanvasApiKeyMissingError: class CanvasApiKeyMissingError extends Error {
    constructor() {
      super("请先配置 API 密钥");
      this.name = "CanvasApiKeyMissingError";
    }
  },
}));

import {
  CanvasVideoCredentialMissingError,
  checkExistingVideoTask,
  pollCanvasVideoTask,
  submitCanvasVideoGeneration,
  visibleCanvasMediaFields,
  type CanvasVideoMediaItem,
} from "../../components/canvas/canvas-video-generation-service";
import {
  __resetCanvasUploadStoreForTests,
  getUploadProgress,
} from "../../components/canvas/lib/canvas-video-upload-store";
import type { InstalledPlugin } from "@/lib/plugin-schema";

function makeFileItem(id: string, kind: CanvasVideoMediaItem["kind"], name: string): CanvasVideoMediaItem {
  const mime = kind === "images" ? "image/png" : kind === "videos" ? "video/mp4" : "audio/mpeg";
  return { id, name, kind, file: new File([new Uint8Array(8)], name, { type: mime }) };
}

function makeRefItem(id: string, name: string, type = "image/png"): CanvasVideoMediaItem {
  return {
    id,
    name,
    kind: "images",
    referenceImage: { id, name, type, dataUrl: `data:${type};base64,${btoa(id)}` },
  };
}

/** 最小可用视频插件：一个档位 facet + 首帧/参考图片/参考视频素材槽 + 提示词 textarea。 */
const plugin: InstalledPlugin = {
  id: "ccode-h3",
  name: "Ccode H3 视频",
  version: "1.0.0",
  kind: "video",
  description: "",
  author: "",
  homepage: "",
  outputs: ["video"],
  credential: { source: "client", label: "key", defaultBaseUrl: "https://pro.ccode.vip" },
  media: { images: { maxCount: 9 }, videos: { maxCount: 3 }, audios: { maxCount: 3 } },
  models: [
    { id: "minimax-h3-original-768p", name: "H3 768P", shortName: "H3 768P", price: { unit: "per-second", amount: 0.15 } },
    { id: "minimax-h3-original-cf-2k", name: "H3 2K", shortName: "H3 2K", price: null },
  ],
  uiSchema: {
    apiVersion: 1,
    modelSelector: {
      facets: [{ key: "tier", label: "档位" }],
      facetOptions: { tier: [{ value: "standard", label: "Standard" }] },
      variants: [{ model: "minimax-h3-original-768p", tier: "standard" }],
    },
    fields: [
      { key: "prompt", type: "textarea", label: "提示词", required: true },
      { key: "firstFrame", type: "media", kind: "images", style: "frame", label: "首帧", required: true, maxCount: { byFacet: "tier", values: { standard: 1 }, default: 0 } },
      { key: "multiImage", type: "media", kind: "images", style: "thumbnail", label: "参考图片", maxCount: { byFacet: "tier", values: { standard: 9 }, default: 0 } },
      { key: "multiVideo", type: "media", kind: "videos", style: "chip", label: "参考视频", maxCount: { byFacet: "tier", values: { standard: 3 }, default: 0 } },
    ],
  },
};

const facets = { tier: "standard" };
const fields = { prompt: "", seconds: 4 };

beforeEach(() => {
  __resetCanvasUploadStoreForTests();
  uploadPluginMediaMock.mockReset();
  createPluginTaskMock.mockReset();
  getPluginTaskMock.mockReset();
  ackPluginTaskMock.mockReset().mockResolvedValue(undefined);
  imageToDataUrlMock.mockReset();
  getPluginCredentialMock.mockReset().mockReturnValue({ apiKey: "sk-test", baseUrl: "https://pro.ccode.vip" });
});

afterEach(() => {
  __resetCanvasUploadStoreForTests();
});

describe("visibleCanvasMediaFields", () => {
  it("按 maxCount 过滤出有名次的素材槽（0 名额的不出现）", () => {
    const slots = visibleCanvasMediaFields(plugin, facets, { ...fields, mode: "first-last-frame" });
    // 这里没有 mode 约束，三个槽都有名额
    expect(slots.map((slot) => slot.field.key)).toEqual(["firstFrame", "multiImage", "multiVideo"]);
    expect(slots[0].maxCount).toBe(1);
    expect(slots[1].maxCount).toBe(9);
  });
});

describe("submitCanvasVideoGeneration", () => {
  it("缺少插件凭据时抛凭据缺失错误（可被 instanceof CanvasApiKeyMissingError 捕获）", async () => {
    getPluginCredentialMock.mockReturnValue({ apiKey: "", baseUrl: "" });

    await expect(
      submitCanvasVideoGeneration({ resultNodeId: "node-1", plugin, prompt: "p", facets, fields, mediaSlots: {} }),
    ).rejects.toBeInstanceOf(CanvasVideoCredentialMissingError);
    expect(createPluginTaskMock).not.toHaveBeenCalled();
  });

  it("逐个上传素材后按槽位组装 media 提交任务", async () => {
    uploadPluginMediaMock.mockImplementation(async (_pluginId: string, file: File) => ({ url: `https://cdn/${file.name}` }));
    createPluginTaskMock.mockResolvedValue("task-1");

    const taskId = await submitCanvasVideoGeneration({
      resultNodeId: "node-1",
      plugin,
      prompt: "画布提示词",
      facets,
      fields,
      mediaSlots: {
        firstFrame: [makeFileItem("f1", "images", "first.png")],
        multiVideo: [makeFileItem("v1", "videos", "a.mp4"), makeFileItem("v2", "videos", "b.mp4")],
        multiImage: [],
      },
    });

    expect(taskId).toBe("task-1");
    // 顺序上传（3 个素材 3 次调用）
    expect(uploadPluginMediaMock).toHaveBeenCalledTimes(3);
    // 提交载荷：插件/凭据/模型/facet/字段（含提示词写入第一个 textarea 字段）/media 按槽分组
    expect(createPluginTaskMock).toHaveBeenCalledWith({
      pluginId: "ccode-h3",
      apiKey: "sk-test",
      baseUrl: "https://pro.ccode.vip",
      model: "minimax-h3-original-768p",
      facets,
      fields: { prompt: "画布提示词", seconds: 4 },
      media: {
        firstFrame: ["https://cdn/first.png"],
        multiImage: [],
        multiVideo: ["https://cdn/a.mp4", "https://cdn/b.mp4"],
      },
    });
    // 上传进度：全部 done
    const progress = getUploadProgress("node-1");
    expect(progress?.map((item) => item.status)).toEqual(["done", "done", "done"]);
  });

  it("画布图片引用经 imageToDataUrl → fetch → File 上传", async () => {
    const blob = new Blob([new Uint8Array(4)], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({ blob: async () => blob });
    vi.stubGlobal("fetch", fetchMock);
    imageToDataUrlMock.mockResolvedValue("data:image/png;base64,AAAA");
    uploadPluginMediaMock.mockResolvedValue({ url: "https://cdn/ref.png" });
    createPluginTaskMock.mockResolvedValue("task-2");

    const ref = makeRefItem("img-node-1", "画布图.png");
    await submitCanvasVideoGeneration({
      resultNodeId: "node-2",
      plugin,
      prompt: "p",
      facets,
      fields,
      mediaSlots: { multiImage: [ref], firstFrame: [], multiVideo: [] },
    });

    expect(imageToDataUrlMock).toHaveBeenCalledWith(ref.referenceImage);
    expect(uploadPluginMediaMock).toHaveBeenCalledWith(
      "ccode-h3",
      expect.objectContaining({ name: "画布图.png" }),
      "images",
      expect.anything(),
    );
    expect(createPluginTaskMock).toHaveBeenCalledWith(expect.objectContaining({ media: expect.objectContaining({ multiImage: ["https://cdn/ref.png"] }) }));
  });

  it("素材上传失败：条目标记 failed 并中止提交", async () => {
    uploadPluginMediaMock.mockRejectedValue(new Error("限流"));

    await expect(
      submitCanvasVideoGeneration({
        resultNodeId: "node-3",
        plugin,
        prompt: "p",
        facets,
        fields,
        mediaSlots: { firstFrame: [makeFileItem("f1", "images", "first.png")], multiImage: [], multiVideo: [] },
      }),
    ).rejects.toThrow("素材「first.png」上传失败：限流");

    expect(createPluginTaskMock).not.toHaveBeenCalled();
    expect(getUploadProgress("node-3")?.[0]).toMatchObject({ status: "failed", error: "限流" });
  });
});

describe("pollCanvasVideoTask", () => {
  it("进行中 → 完成：回调进度并返回视频产物（完成后 ack）", async () => {
    getPluginTaskMock
      .mockResolvedValueOnce({ id: "t", status: "processing", progress: 10, upstreamStatus: "processing" })
      .mockResolvedValueOnce({ id: "t", status: "completed", result: { assets: [{ kind: "video", url: "https://cdn/v.mp4", posterUrl: "https://cdn/p.jpg", durationSec: 5 }] } });

    const onProgress = vi.fn();
    const result = await pollCanvasVideoTask("t", onProgress);

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "processing", progress: 10 }));
    expect(result).toEqual({ videoUrl: "https://cdn/v.mp4", posterUrl: "https://cdn/p.jpg", durationSec: 5 });
    expect(ackPluginTaskMock).toHaveBeenCalledWith("t");
  });

  it("本机队列的「排队中」归一化为 queued", async () => {
    getPluginTaskMock.mockResolvedValueOnce({ id: "t", status: "排队中" });

    const onProgress = vi.fn();
    // 用一个立刻完成的第二轮避免死循环
    getPluginTaskMock.mockResolvedValueOnce({ id: "t", status: "completed", result: { assets: [{ kind: "video", url: "u" }] } });
    await pollCanvasVideoTask("t", onProgress);

    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "queued" }));
  });

  it("失败终态：抛出上游错误并 ack", async () => {
    getPluginTaskMock.mockResolvedValue({ id: "t", status: "failed", error: "上游超时" });

    await expect(pollCanvasVideoTask("t", vi.fn())).rejects.toThrow("上游超时");
    expect(ackPluginTaskMock).toHaveBeenCalledWith("t");
  });
});

describe("checkExistingVideoTask", () => {
  it("完成态附带视频产物", async () => {
    getPluginTaskMock.mockResolvedValue({
      id: "t",
      status: "completed",
      result: { assets: [{ kind: "video", url: "https://cdn/v.mp4", durationSec: 6 }] },
    });

    const result = await checkExistingVideoTask("t");
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ videoUrl: "https://cdn/v.mp4", durationSec: 6 });
  });

  it("进行中返回进度；失败返回错误文案", async () => {
    getPluginTaskMock.mockResolvedValueOnce({ id: "t", status: "processing", progress: 42 });
    const running = await checkExistingVideoTask("t");
    expect(running).toMatchObject({ status: "processing", progress: 42 });
    expect(running.result).toBeUndefined();

    getPluginTaskMock.mockResolvedValueOnce({ id: "t", status: "expired" });
    const expired = await checkExistingVideoTask("t");
    expect(expired.error).toBe("该任务已超出取回时间");
  });
});
