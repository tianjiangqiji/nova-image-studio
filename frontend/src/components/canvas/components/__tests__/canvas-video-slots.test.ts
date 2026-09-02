import { describe, expect, it } from "vitest";

import { summarizeSchemaParams, type InstalledPlugin } from "@/lib/plugin-schema";
import { computeCanvasVideoBlockReason, computeCanvasVideoSlotCounts } from "../canvas-video-config-section";
import type { CanvasPendingMedia } from "../../lib/canvas-video-media-store";

/** 一个覆盖四类素材槽（首帧 / 参考图 / 参考视频 / 参考音频）的插件夹具。 */
function makePlugin(): InstalledPlugin {
  return {
    id: "demo-video",
    name: "Demo Video",
    version: "1.0.0",
    kind: "video",
    description: "",
    author: "",
    homepage: "",
    outputs: ["video"],
    credential: { source: "client", label: "Demo Key", defaultBaseUrl: "https://example.com" },
    media: { images: { maxCount: 4 }, videos: { maxCount: 2 }, audios: { maxCount: 2 } },
    models: [
      { id: "demo-v1", name: "Demo V1", shortName: "V1", price: { unit: "per-second", amount: 0.5, currency: "CNY" } },
    ],
    uiSchema: {
      apiVersion: 1,
      priceQuantityField: "seconds",
      modelSelector: {
        label: "模型",
        facets: [{ key: "tier", label: "档位" }],
        facetOptions: { tier: [{ value: "pro", label: "专业", fullLabel: "专业版" }] },
        variants: [{ tier: "pro", model: "demo-v1" }],
      },
      fields: [
        { key: "prompt", type: "textarea", label: "提示词" },
        { key: "seconds", type: "select", label: "时长", suffix: "s", options: [{ value: 5, label: "5" }] },
        { key: "firstFrame", type: "media", kind: "images", style: "frame", label: "首帧", maxCount: 1 },
        { key: "refImages", type: "media", kind: "images", label: "参考图", maxCount: 2 },
        { key: "refVideos", type: "media", kind: "videos", label: "参考视频", maxCount: 2 },
        { key: "refAudios", type: "media", kind: "audios", label: "参考音频", maxCount: 1 },
      ],
    },
  };
}

function pendingFile(slot: string, kind: CanvasPendingMedia["kind"]): CanvasPendingMedia {
  return { id: `${slot}-file`, slot, kind, file: new File(["x"], `${slot}.bin`), previewUrl: "blob:x" };
}

const baseArgs = {
  plugin: makePlugin(),
  facets: { tier: "pro" },
  fields: { prompt: "一只猫", seconds: 5 },
  imageCount: 0,
  frameRefs: {},
  canvasImageIds: new Set<string>(),
  mediaRefs: {},
  canvasMediaIds: new Set<string>(),
  pendingMedia: [] as CanvasPendingMedia[],
};

describe("computeCanvasVideoSlotCounts", () => {
  it("counts canvas video/audio node references alongside local uploads", () => {
    const counts = computeCanvasVideoSlotCounts({
      ...baseArgs,
      mediaRefs: { refVideos: ["video-1"], refAudios: ["audio-1"] },
      canvasMediaIds: new Set(["video-1", "audio-1"]),
      pendingMedia: [pendingFile("refVideos", "videos")],
    });
    const bySlot = Object.fromEntries(counts.map((slot) => [slot.field.key, slot.count]));
    expect(bySlot.refVideos).toBe(2);
    expect(bySlot.refAudios).toBe(1);
  });

  it("ignores references whose canvas node no longer exists", () => {
    const counts = computeCanvasVideoSlotCounts({
      ...baseArgs,
      mediaRefs: { refVideos: ["deleted-node"] },
      canvasMediaIds: new Set(["video-1"]),
    });
    expect(counts.find((slot) => slot.field.key === "refVideos")?.count).toBe(0);
  });

  it("keeps frame references and @ image references on their own slots", () => {
    const counts = computeCanvasVideoSlotCounts({
      ...baseArgs,
      imageCount: 2,
      frameRefs: { firstFrame: "image-1" },
      canvasImageIds: new Set(["image-1"]),
    });
    const bySlot = Object.fromEntries(counts.map((slot) => [slot.field.key, slot.count]));
    expect(bySlot.firstFrame).toBe(1);
    expect(bySlot.refImages).toBe(2);
    expect(bySlot.refVideos).toBe(0);
  });

  it("blocks submission when a slot exceeds its quota", () => {
    expect(
      computeCanvasVideoBlockReason({
        ...baseArgs,
        mediaRefs: { refAudios: ["audio-1", "audio-2"] },
        canvasMediaIds: new Set(["audio-1", "audio-2"]),
      }),
    ).toBe("「参考音频」最多 1 个");
  });

  it("allows submission when every slot is within quota", () => {
    expect(
      computeCanvasVideoBlockReason({
        ...baseArgs,
        mediaRefs: { refVideos: ["video-1"] },
        canvasMediaIds: new Set(["video-1"]),
      }),
    ).toBeNull();
  });
});

describe("summarizeSchemaParams", () => {
  it("snapshots facet labels and visible select fields with suffixes", () => {
    expect(summarizeSchemaParams(makePlugin(), { tier: "pro" }, { seconds: 5 })).toEqual([
      { label: "档位", value: "专业版" },
      { label: "时长", value: "5s" },
    ]);
  });
});
