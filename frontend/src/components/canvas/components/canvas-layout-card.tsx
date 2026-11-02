"use client";

import { useMemo, useState } from "react";
import { Braces, ImageIcon, Type } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  buildLayoutPromptSection,
  renderLayoutReferenceImage,
  stringifyLayoutSpec,
  type LayoutSpec,
} from "@/lib/layout-spec";
import type { CanvasNodeData } from "../types";

type LayoutCardTab = "preview" | "json" | "prompt";

const TABS: { value: LayoutCardTab; label: string; icon: typeof ImageIcon }[] = [
  { value: "preview", label: "预览", icon: ImageIcon },
  { value: "json", label: "JSON", icon: Braces },
  { value: "prompt", label: "文字", icon: Type },
];

/**
 * 构图卡片：画布上的构图规范容器。
 * 三份内容都由同一份构图 JSON 实时生成——预览图、JSON 原文、提示词段落，
 * 因此卡片本身只持久化 JSON，其余不落库。
 */
export function CanvasLayoutCardBody({
  data,
  onSelectNode,
}: {
  data: CanvasNodeData;
  onSelectNode: (nodeId: string) => void;
}) {
  const [tab, setTab] = useState<LayoutCardTab>("preview");
  const spec = data.metadata?.layoutSpec as LayoutSpec | undefined;

  const referenceImage = useMemo(() => (spec ? renderLayoutReferenceImage(spec) : null), [spec]);
  const json = useMemo(() => (spec ? stringifyLayoutSpec(spec) : ""), [spec]);
  const promptSection = useMemo(() => (spec ? buildLayoutPromptSection(spec) : ""), [spec]);

  if (!spec) {
    return (
      <div className="grid h-full w-full place-items-center px-3 text-center text-[11px] text-muted-foreground">
        构图数据缺失
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col" onPointerDown={() => onSelectNode(data.id)}>
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5" data-canvas-no-zoom>
        {TABS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setTab(item.value);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                active
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-3" />
              {item.label}
            </button>
          );
        })}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {spec.objects.length} 个物体
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-1.5 pb-1.5 pt-1">
        {tab === "preview" &&
          (referenceImage ? (
            <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/20">
              <img
                src={referenceImage}
                alt="构图预览"
                className="max-h-full max-w-full object-contain"
                draggable={false}
              />
            </div>
          ) : (
            <div className="grid h-full w-full place-items-center text-[11px] text-muted-foreground">
              当前环境无法渲染预览图
            </div>
          ))}

        {tab === "json" && (
          <pre className="h-full w-full overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {json}
          </pre>
        )}

        {tab === "prompt" && (
          <pre className="h-full w-full overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {promptSection || "（空白构图）"}
          </pre>
        )}
      </div>
    </div>
  );
}
