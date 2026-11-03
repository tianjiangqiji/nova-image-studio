import { describe, expect, it, vi } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types";

// jsdom 没有 canvas 2D 后端，线框图渲染固定返回一张占位 PNG；
// 其余 layout-spec 能力保持真实实现，只验证「文字段落 + 参考图」是否同时注入。
vi.mock("@/lib/layout-spec", async () => {
  const actual = await vi.importActual<typeof import("@/lib/layout-spec")>("@/lib/layout-spec");
  return {
    ...actual,
    renderLayoutReferenceImage: vi.fn(() => "data:image/png;base64,c3R1Yg=="),
  };
});

const { buildNodeGenerationContext, buildNodeGenerationInputs } = await import("../canvas-node-generation");
const { createEmptyLayoutSpec } = await import("@/lib/layout-spec");
type LayoutSpec = import("@/lib/layout-spec").LayoutSpec;

function node(
  id: string,
  type: CanvasNodeType,
  title: string,
  metadata: CanvasNodeData["metadata"] = {},
): CanvasNodeData {
  return { id, type, title, metadata, position: { x: 0, y: 0 }, width: 240, height: 160 };
}

function edge(id: string, fromNodeId: string, toNodeId: string): CanvasConnection {
  return { id, fromNodeId, toNodeId };
}

describe("buildNodeGenerationContext prompt routes", () => {
  it("joins selected route text before the config supplement", () => {
    const nodes = [
      node("core", CanvasNodeType.Text, "核心提示词", { content: "核心提示词" }),
      node("concept", CanvasNodeType.Text, "城市创意", { content: "城市创意" }),
      node("beijing", CanvasNodeType.Text, "北京专属", { content: "北京专属" }),
      node("config", CanvasNodeType.Config, "北京生成配置", {
        composerContent: "胶片海报质感",
        promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config"] },
      }),
    ];
    const connections = [
      edge("core-concept", "core", "concept"),
      edge("concept-beijing", "concept", "beijing"),
      edge("core-beijing", "core", "beijing"),
      edge("beijing-config", "beijing", "config"),
    ];

    const context = buildNodeGenerationContext("config", nodes, connections, "胶片海报质感");

    expect(context.prompt).toBe("核心提示词\n\n城市创意\n\n北京专属\n\n胶片海报质感");
    expect(context.textCount).toBe(3);
    expect(context.routeValid).toBe(true);
    expect(context.route?.connectionIds).toEqual(["core-concept", "concept-beijing", "beijing-config"]);
  });

  it("omits empty route text blocks", () => {
    const nodes = [
      node("empty", CanvasNodeType.Text, "空节点", { content: "   " }),
      node("city", CanvasNodeType.Text, "城市", { content: "北京" }),
      node("config", CanvasNodeType.Config, "配置", {
        promptRouteSelection: { mode: "route", connectionIds: ["empty-city", "city-config"] },
      }),
    ];
    const connections = [edge("empty-city", "empty", "city"), edge("city-config", "city", "config")];

    expect(buildNodeGenerationContext("config", nodes, connections, "").prompt).toBe("北京");
  });

  it("deduplicates route text mentions and includes referenced images", () => {
    const nodes = [
      node("core", CanvasNodeType.Text, "核心提示词", { content: "核心内容" }),
      node("city", CanvasNodeType.Text, "北京专属", { content: "北京内容" }),
      node("image", CanvasNodeType.Image, "参考图", { content: "data:image/png;base64,abc", mimeType: "image/png" }),
      node("config", CanvasNodeType.Config, "配置", {
        composerContent: "结合 @[node:city] 和 @[node:image]",
        promptRouteSelection: { mode: "route", connectionIds: ["core-city", "city-config"] },
      }),
    ];
    const connections = [
      edge("core-city", "core", "city"),
      edge("city-config", "city", "config"),
      edge("image-config", "image", "config"),
    ];

    const context = buildNodeGenerationContext("config", nodes, connections, "结合 @[node:city] 和 @[node:image]");

    expect(context.prompt).toBe("核心内容\n\n北京内容\n\n结合 北京专属 和 图片1");
    expect(context.prompt.match(/北京内容/g)).toHaveLength(1);
    expect(context.referenceImages.map((image) => image.id)).toEqual(["image"]);
  });

  it("marks a stale selected route invalid without falling back", () => {
    const nodes = [
      node("city", CanvasNodeType.Text, "北京", { content: "北京内容" }),
      node("config", CanvasNodeType.Config, "配置", {
        composerContent: "补充",
        promptRouteSelection: { mode: "route", connectionIds: ["missing"] },
      }),
    ];
    const connections = [edge("city-config", "city", "config")];

    const context = buildNodeGenerationContext("config", nodes, connections, "补充");

    expect(context.routeValid).toBe(false);
    expect(context.prompt).toBe("补充");
    expect(context.route).toBeUndefined();
  });

  it("preserves manual composer behavior", () => {
    const nodes = [
      node("city", CanvasNodeType.Text, "北京", { content: "北京内容" }),
      node("config", CanvasNodeType.Config, "配置", {
        composerContent: "使用 @[node:city]",
        promptRouteSelection: { mode: "manual" },
      }),
    ];
    const connections = [edge("city-config", "city", "config")];

    const context = buildNodeGenerationContext("config", nodes, connections, "使用 @[node:city]");

    expect(context.prompt).toBe("使用 【文本1】\n\n【文本1】\n北京内容");
    expect(context.routeValid).toBe(true);
  });

  it("automatically includes the previous generated image for a downstream config", () => {
    const nodes = [
      node("original", CanvasNodeType.Image, "原始图片", { content: "data:image/png;base64,original" }),
      node("first-config", CanvasNodeType.Config, "首次生成", { composerContent: "首次生成" }),
      node("generated", CanvasNodeType.Image, "首次生成 - 结果 1", { content: "data:image/png;base64,generated" }),
      node("second-config", CanvasNodeType.Config, "继续修改", {
        composerContent: "把天空改成傍晚",
        promptRouteSelection: { mode: "manual" },
      }),
    ];
    const connections = [
      edge("original-first", "original", "first-config"),
      edge("first-generated", "first-config", "generated"),
      edge("generated-second", "generated", "second-config"),
    ];

    const context = buildNodeGenerationContext("second-config", nodes, connections, "把天空改成傍晚");

    expect(context.referenceImages.map((image) => image.id)).toEqual(["generated"]);
    expect(context.imageCount).toBe(1);
  });
});

const layoutSpec: LayoutSpec = {
  version: 1,
  aspectRatio: "1:1",
  objects: [
    { id: "obj_1", label: "蓝色机器人", box: { x: 0.08, y: 0.12, w: 0.22, h: 0.55 } },
    { id: "obj_2", label: "橙色方块", box: { x: 0.6, y: 0.2, w: 0.2, h: 0.3 } },
  ],
  relations: [{ from: "obj_1", type: "left-of", to: "obj_2" }],
};

describe("构图卡片生成输入", () => {
  it("同一节点同时贡献文字段落与参考图，缺一不可", () => {
    const nodes = [
      node("card", CanvasNodeType.LayoutCard, "构图", { layoutSpec }),
      node("config", CanvasNodeType.Config, "构图生成配置", { composerContent: "参考构图：@[node:card]" }),
    ];
    const connections = [edge("card-config", "card", "config")];

    const inputs = buildNodeGenerationInputs("config", nodes, connections);
    expect(inputs.filter((input) => input.type === "text")).toHaveLength(1);
    expect(inputs.filter((input) => input.type === "image")).toHaveLength(1);

    const context = buildNodeGenerationContext("config", nodes, connections, "参考构图：@[node:card]");
    expect(context.prompt).toContain("【构图规范 v1】");
    expect(context.prompt).toContain("蓝色机器人");
    expect(context.textCount).toBe(1);
    expect(context.imageCount).toBe(1);
    expect(context.referenceImages).toHaveLength(1);
  });

  it("空构图不产生输入", () => {
    const nodes = [
      node("card", CanvasNodeType.LayoutCard, "构图", { layoutSpec: createEmptyLayoutSpec("1:1") }),
      node("config", CanvasNodeType.Config, "配置", { composerContent: "@[node:card]" }),
    ];
    expect(buildNodeGenerationInputs("config", nodes, [edge("card-config", "card", "config")])).toEqual([]);
  });
});
