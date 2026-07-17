"use client";

import { Lock, LockOpen, Sparkles, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GenerationParamsBar, type GenerationParamsValue } from "@/components/GenerationParamsBar";
import { cn } from "@/lib/utils";
import { normalizeModel } from "@/lib/model-capabilities";
import { CanvasMentionEditor } from "./canvas-mention-editor";
import { Spinner } from "./canvas-ui";
import type { CanvasGenerationConfig } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

/** 渲染在「编排节点」内部：提示词（@ 引用）+ 模型参数（复用宿主 GenerationParamsBar，含自定义分辨率）+ 生成按钮。 */
export function CanvasConfigNodePanel({
  prompt,
  references,
  config,
  lockResultNodes,
  referenceLimit,
  busy,
  optimizing,
  onPromptChange,
  onConfigChange,
  onToggleLock,
  onSelect,
  onOptimizePrompt,
  onGenerate,
}: {
  prompt: string;
  references: CanvasResourceReference[];
  config: CanvasGenerationConfig;
  lockResultNodes: boolean;
  referenceLimit: { imageCount: number; max: number; exceeded: boolean };
  busy: boolean;
  optimizing: boolean;
  onPromptChange: (value: string) => void;
  onConfigChange: (patch: Partial<CanvasGenerationConfig>) => void;
  onToggleLock: () => void;
  onSelect: () => void;
  onOptimizePrompt: () => void;
  onGenerate: () => void;
}) {
  const value: GenerationParamsValue = {
    model: normalizeModel(config.model),
    outputSize: config.outputSize,
    customSize: config.customSize,
    aspectRatio: config.aspectRatio,
    temperature: config.temperature,
    parallelCount: config.count,
    gptImageAdvancedParams: { quality: config.gptImageQuality, style: config.gptImageStyle, background: config.gptImageBackground },
  };

  const handleParamsChange = (patch: Partial<GenerationParamsValue>) => {
    const next: Partial<CanvasGenerationConfig> = {};
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.outputSize !== undefined) next.outputSize = patch.outputSize;
    if ("customSize" in patch) next.customSize = patch.customSize;
    if (patch.aspectRatio !== undefined) next.aspectRatio = patch.aspectRatio;
    if (patch.temperature !== undefined) next.temperature = patch.temperature;
    if (patch.parallelCount !== undefined) next.count = patch.parallelCount;
    if (patch.gptImageAdvancedParams) {
      next.gptImageQuality = patch.gptImageAdvancedParams.quality;
      next.gptImageStyle = patch.gptImageAdvancedParams.style;
      next.gptImageBackground = patch.gptImageAdvancedParams.background;
    }
    onConfigChange(next);
  };

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-xs" onPointerDown={() => onSelect()}>
      <div className="min-h-0 flex-1 cursor-text overflow-auto rounded-lg border border-input bg-background p-1.5" data-no-drag>
        <CanvasMentionEditor value={prompt} references={references} onChange={onPromptChange} placeholder="提示词，输入 @ 引用上游节点…" className="min-h-[56px] text-xs" />
      </div>

      <div className="shrink-0 space-y-2">
        <GenerationParamsBar
          value={value}
          onChange={handleParamsChange}
          size="xs"
        />
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            onClick={onOptimizePrompt}
            disabled={busy || optimizing || !prompt.trim()}
            className="shrink-0 gap-1"
            title="优化提示词（结合连接的上游图片/文字）"
          >
            {optimizing ? <Spinner className="size-3.5" /> : <Wand2 className="size-3.5" />}
          </Button>
          <Button
            variant={lockResultNodes ? "secondary" : "outline"}
            size="xs"
            onClick={onToggleLock}
            className={cn("flex-1 gap-1", lockResultNodes && "border-primary text-primary")}
            title={lockResultNodes ? "已锁定：结果直接覆盖连接的图片节点" : "未锁定：每次生成新建结果图片节点"}
          >
            {lockResultNodes ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
            <span className="text-[11px]">{lockResultNodes ? "将覆盖已有结果节点" : "将新建结果节点"}</span>
          </Button>
          <Button size="sm" onClick={onGenerate} disabled={busy || referenceLimit.exceeded} className="flex-1">
            {busy ? <Spinner className="size-4" /> : <Sparkles className="size-4" />}
            生成
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] leading-tight">
          <span className={cn("min-w-0 truncate", referenceLimit.exceeded ? "text-destructive" : "text-muted-foreground")}>
            {referenceLimit.max <= 0
              ? "当前模型不支持参考图"
              : `当前模型允许参考图数量：${referenceLimit.max}`}
          </span>
          <span className={cn("shrink-0", referenceLimit.exceeded ? "text-destructive" : "text-muted-foreground")}>
            {referenceLimit.exceeded
              ? (referenceLimit.max <= 0 ? "请移除 @ 图片引用" : "参考图超过模型限制")
              : `已连接 ${referenceLimit.imageCount} 张`}
          </span>
        </div>
      </div>
    </div>
  );
}
