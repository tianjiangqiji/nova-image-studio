"use client";

import { cn } from "@/lib/utils";
import { computeMinimapLayout, nodeMinimapColor } from "../utils/canvas-minimap-layout";
import { type CanvasNodeData } from "../types";

const THUMB_W = 300;
const THUMB_H = 200;

/** 列表卡片用的静态缩略图：复用小地图的极简彩色矩形渲染；空画布占位但尺寸不变。 */
export function CanvasThumbnail({ nodes, className }: { nodes: CanvasNodeData[]; className?: string }) {
  const boxClass = cn("relative aspect-[3/2] w-full overflow-hidden rounded-xl border border-border bg-muted/40", className);

  if (!nodes.length) {
    return (
      <div className={boxClass}>
        <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">画布为空</div>
      </div>
    );
  }

  const layout = computeMinimapLayout(nodes, THUMB_W, THUMB_H);

  return (
    <div className={boxClass}>
      {nodes.map((node) => {
        const pos = layout.toMinimap(node.position.x, node.position.y);
        const color = nodeMinimapColor(node.type, "var(--muted-foreground)");
        const width = Math.max(node.width * layout.scale, 2);
        const height = Math.max(node.height * layout.scale, 2);
        return (
          <div
            key={node.id}
            className="absolute rounded-[1px]"
            style={{
              left: `${(pos.x / THUMB_W) * 100}%`,
              top: `${(pos.y / THUMB_H) * 100}%`,
              width: `${(width / THUMB_W) * 100}%`,
              height: `${(height / THUMB_H) * 100}%`,
              backgroundColor: color,
              opacity: 0.85,
            }}
          />
        );
      })}
    </div>
  );
}
