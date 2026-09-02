import { CanvasNodeType, type CanvasNodeData } from "../types";

export type MinimapLayout = {
  worldBounds: { x: number; y: number; w: number; h: number };
  scale: number;
  offset: { x: number; y: number };
  toMinimap: (worldX: number, worldY: number) => { x: number; y: number };
};

const MARGIN = 500;

/**
 * 把一组节点的世界坐标，按「适配 + 居中」映射到 width×height 的小图盒子里。
 * 纯函数，小地图与列表缩略图共用（无视口/交互依赖）。
 */
export function computeMinimapLayout(nodes: CanvasNodeData[], width: number, height: number): MinimapLayout {
  let worldBounds: MinimapLayout["worldBounds"];

  if (!nodes.length) {
    worldBounds = { x: -MARGIN, y: -MARGIN, w: MARGIN * 2, h: MARGIN * 2 };
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach((node) => {
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + node.width);
      maxY = Math.max(maxY, node.position.y + node.height);
    });
    minX -= MARGIN;
    minY -= MARGIN;
    maxX += MARGIN;
    maxY += MARGIN;
    worldBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  const scale = Math.min(width / worldBounds.w, height / worldBounds.h);
  const offset = { x: (width - worldBounds.w * scale) / 2, y: (height - worldBounds.h * scale) / 2 };
  const toMinimap = (worldX: number, worldY: number) => ({
    x: (worldX - worldBounds.x) * scale + offset.x,
    y: (worldY - worldBounds.y) * scale + offset.y,
  });

  return { worldBounds, scale, offset, toMinimap };
}

/** 节点类型 → 小图色块颜色（小地图与列表缩略图共用一套配色）。 */
export function nodeMinimapColor(type: CanvasNodeType, fallback: string): string {
  if (type === CanvasNodeType.Image) return "#10b981";
  if (type === CanvasNodeType.Config) return "#60a5fa";
  if (type === CanvasNodeType.Video) return "#a78bfa";
  if (type === CanvasNodeType.Audio) return "#f59e0b";
  return fallback;
}
