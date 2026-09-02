import { CanvasNodeType } from "./types";
import type { CanvasNodeMetadata } from "./types";

type CanvasNodeSpec = {
  width: number;
  height: number;
  title: string;
  metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
  [CanvasNodeType.Image]: { width: 340, height: 240, title: "图片节点" },
  [CanvasNodeType.Video]: { width: 360, height: 280, title: "视频节点" },
  [CanvasNodeType.Audio]: { width: 320, height: 150, title: "音频节点" },
  [CanvasNodeType.Text]: { width: 340, height: 200, title: "文本" },
  [CanvasNodeType.Config]: { width: 380, height: 440, title: "编排节点" },
  [CanvasNodeType.TextAnnotation]: { width: 240, height: 160, title: "注释" },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

export const NODE_SPECS = {
  [CanvasNodeType.Image]: {
    ...NODE_DEFAULT_SIZE[CanvasNodeType.Image],
    metadata: { content: "", status: "idle" },
  },
  [CanvasNodeType.Video]: {
    ...NODE_DEFAULT_SIZE[CanvasNodeType.Video],
    metadata: { content: "", status: "idle" },
  },
  [CanvasNodeType.Audio]: {
    ...NODE_DEFAULT_SIZE[CanvasNodeType.Audio],
    metadata: { content: "", status: "idle" },
  },
  [CanvasNodeType.Text]: {
    ...NODE_DEFAULT_SIZE[CanvasNodeType.Text],
    metadata: { content: "", status: "idle", fontSize: 14 },
  },
  [CanvasNodeType.Config]: {
    ...NODE_DEFAULT_SIZE[CanvasNodeType.Config],
    metadata: { content: "", status: "idle", generationMode: "image" },
  },
  [CanvasNodeType.TextAnnotation]: {
    ...NODE_DEFAULT_SIZE[CanvasNodeType.TextAnnotation],
    metadata: { content: "", status: "idle", fontSize: 14 },
  },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

export function getNodeSpec(type: CanvasNodeType) {
  return NODE_SPECS[type];
}
