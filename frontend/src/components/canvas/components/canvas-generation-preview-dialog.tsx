"use client";

import { Copy, Film, Image as ImageIcon, Route, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MODEL_OPTIONS, isGptImageModel } from "@/lib/gemini-config";
import {
  GPT_IMAGE_BACKGROUND_OPTIONS,
  GPT_IMAGE_QUALITY_OPTIONS,
  GPT_IMAGE_STYLE_OPTIONS,
  getOutputSizeLabel,
  getSupportsTemperature,
  normalizeModel,
} from "@/lib/model-capabilities";
import {
  estimateCost,
  findModel,
  resolveModel,
  summarizeSchemaParams,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
} from "@/lib/plugin-schema";
import type { NodeGenerationContext } from "./canvas-node-generation";
import type { CanvasGenerationConfig, CanvasGenerationMode, CanvasNodeData } from "../types";

/** 视频模式的预览信息（由 CanvasEditor 按当前编排节点组装）。 */
export type CanvasVideoPreviewInfo = {
  plugin: InstalledPlugin | null;
  facets: FacetValues;
  fields: FieldValues;
  /** 素材槽占用：画布引用 + 本地上传 */
  slots: { label: string; count: number; maxCount: number }[];
  /** 提示词写入插件的哪个字段（用于说明这段提示词的去处） */
  promptFieldLabel?: string;
};

export function CanvasGenerationPreviewDialog({
  open,
  onOpenChange,
  node,
  context,
  config,
  mode = "image",
  video,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: CanvasNodeData | null;
  context: NodeGenerationContext | null;
  config: CanvasGenerationConfig | null;
  /** 当前编排节点的生成模式；视频模式下展示插件参数而不是图片参数 */
  mode?: CanvasGenerationMode;
  video?: CanvasVideoPreviewInfo | null;
  onCopy: (text: string) => void;
}) {
  const isVideo = mode === "video";
  const plugin = video?.plugin ?? null;
  const videoModel = plugin ? resolveModel(plugin.uiSchema, video?.facets ?? {}) : null;
  const videoModelInfo = plugin && videoModel ? findModel(plugin, videoModel) : undefined;
  const videoChips = plugin ? summarizeSchemaParams(plugin, video?.facets ?? {}, video?.fields ?? {}) : [];
  const videoCost = plugin && videoModel ? estimateCost(plugin, videoModel, video?.fields ?? {}) : null;
  const currency = videoModelInfo?.price?.currency === "USD" ? "$" : "¥";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          {/* 模式做成标题旁的小标签而不是写进标题：对话框的可访问名保持稳定 */}
          <div className="flex items-center gap-2">
            <DialogTitle>生成预览</DialogTitle>
            <span className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {isVideo ? "视频模式" : "图片模式"}
            </span>
          </div>
        </DialogHeader>
        {node && context && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <PreviewMeta icon={<Route />} label="提示词路线" value={context.route?.label || "手动编排"} />
              <PreviewMeta
                icon={<ImageIcon />}
                label="引用资源"
                value={isVideo ? describeVideoSlots(video, context) : `${context.textCount} 段文本 / ${context.imageCount} 张图片`}
              />
              {isVideo ? (
                <PreviewMeta
                  icon={<Film />}
                  label="视频插件"
                  value={plugin ? `${plugin.name}${videoModelInfo ? ` · ${videoModelInfo.shortName || videoModelInfo.name}` : ""}` : "未安装视频插件"}
                />
              ) : (
                <PreviewMeta icon={<Settings2 />} label="生成参数" value={config ? describeImageParams(config) : "—"} />
              )}
            </div>

            {/* 视频模式：schema 驱动的参数快照 + 模型 ID + 预估计费 */}
            {isVideo && plugin && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {videoChips.map((chip) => (
                    <span key={`${chip.label}-${chip.value}`} className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground">
                      {chip.label}：{chip.value}
                    </span>
                  ))}
                  {videoCost !== null && (
                    <span className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      预估计费：{currency}{videoCost.toFixed(2)}
                    </span>
                  )}
                </div>
                {videoModel && <p className="font-mono text-[10px] text-muted-foreground/80">{videoModel}</p>}
              </div>
            )}

            {/* 图片模式：gpt-image 高级参数与温度只在支持的模型上出现 */}
            {!isVideo && config && (
              <div className="flex flex-wrap gap-1.5">
                {describeImageExtras(config).map((chip) => (
                  <span key={chip} className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground">{chip}</span>
                ))}
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{node.title} · 最终提示词</span>
                <Button variant="outline" size="xs" onClick={() => onCopy(context.prompt)}>
                  <Copy className="size-3.5" />
                  复制
                </Button>
              </div>
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">{context.prompt || "（提示词为空）"}</pre>
              {isVideo && video?.promptFieldLabel && (
                <p className="mt-1 text-[11px] text-muted-foreground">提交时写入插件字段「{video.promptFieldLabel}」</p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 图片模式主参数：模型友好名 · 分辨率（自定义优先）· 比例 · 张数。 */
function describeImageParams(config: CanvasGenerationConfig) {
  const model = normalizeModel(config.model);
  const modelLabel = MODEL_OPTIONS.find((option) => option.value === model)?.label || config.model;
  const parts = [modelLabel];
  // gpt-image 系列不提供分辨率档位，展示它只会误导
  if (!isGptImageModel(model)) parts.push(config.customSize || getOutputSizeLabel(config.outputSize));
  parts.push(config.aspectRatio === "auto" ? "自动比例" : config.aspectRatio);
  parts.push(`${config.count} 张`);
  return parts.join(" · ");
}

/** 图片模式的附加参数标签：只列当前模型真正生效的那些。 */
function describeImageExtras(config: CanvasGenerationConfig): string[] {
  const model = normalizeModel(config.model);
  const chips: string[] = [];
  if (isGptImageModel(model)) {
    const quality = GPT_IMAGE_QUALITY_OPTIONS.find((option) => option.value === config.gptImageQuality)?.label || config.gptImageQuality;
    const style = GPT_IMAGE_STYLE_OPTIONS.find((option) => option.value === config.gptImageStyle)?.label || config.gptImageStyle;
    const background = GPT_IMAGE_BACKGROUND_OPTIONS.find((option) => option.value === config.gptImageBackground)?.label || config.gptImageBackground;
    chips.push(`质量：${quality}`, `风格：${style}`, `背景：${background}`);
  }
  if (getSupportsTemperature(model)) chips.push(`温度：${config.temperature.toFixed(2)}`);
  return chips;
}

/** 视频模式的素材占用摘要：没有素材槽时退回 @ 引用图片数。 */
function describeVideoSlots(video: CanvasVideoPreviewInfo | null | undefined, context: NodeGenerationContext) {
  if (!video?.plugin) return `${context.imageCount} 张图片（未安装插件）`;
  if (!video.slots.length) return "该组合不需要素材";
  return video.slots.map((slot) => `${slot.label} ${slot.count}/${slot.maxCount}`).join(" · ");
}

export type CanvasBatchPreviewItem = {
  node: CanvasNodeData;
  valid: boolean;
  reason?: string;
  imageCount: number;
};

export function CanvasBatchGenerationDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CanvasBatchPreviewItem[];
  onConfirm: () => void;
}) {
  const validItems = items.filter((item) => item.valid);
  const totalImages = validItems.reduce((sum, item) => sum + item.imageCount, 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量生成</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm">已选择 {items.length} 个配置，其中 {validItems.length} 个可生成，预计产出 {totalImages} 个结果。</p>
          <div className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2">
            {items.map((item) => (
              <div key={item.node.id} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted/60">
                <span className="min-w-0 truncate font-medium">{item.node.title}</span>
                <span className={item.valid ? "shrink-0 text-muted-foreground" : "shrink-0 text-destructive"}>{item.valid ? `${item.imageCount} 个` : item.reason}</span>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!validItems.length} onClick={onConfirm}>开始生成 {validItems.length} 个配置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewMeta({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border p-2 transition-colors hover:bg-muted/40">
      <span className="mb-1 flex items-center gap-1 text-muted-foreground [&_svg]:size-3.5">{icon}{label}</span>
      <span className="block truncate font-medium" title={value}>{value}</span>
    </div>
  );
}
