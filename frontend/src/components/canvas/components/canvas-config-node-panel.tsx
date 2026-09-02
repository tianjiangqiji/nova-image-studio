"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Eye, Film, Image as ImageIcon, Lock, LockOpen, Sparkles, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/toggle-group";
import { GenerationParamsBar, type GenerationParamsValue } from "@/components/GenerationParamsBar";
import { cn } from "@/lib/utils";
import { normalizeModel } from "@/lib/model-capabilities";
import { CanvasMentionEditor } from "./canvas-mention-editor";
import { Spinner } from "./canvas-ui";
import {
  CanvasVideoConfigSection,
  computeCanvasVideoBlockReason,
  type CanvasImageOption,
} from "./canvas-video-config-section";
import { getPendingMedia, subscribePendingMedia } from "../lib/canvas-video-media-store";
import { findCanvasPromptField } from "../canvas-video-generation-service";
import type { FacetValues, FieldValues, InstalledPlugin } from "@/lib/plugin-schema";
import type { CanvasGenerationConfig, CanvasGenerationMode } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

export type CanvasPromptRouteOption = { value: string; label: string; disabled?: boolean };

/** 面板消费的视频模式配置（由 CanvasEditor 按当前节点插件状态组装）。 */
export interface CanvasVideoPanelConfig {
  configNodeId: string;
  /** 已安装的视频插件（至少一个才有视频模式可用） */
  plugins: InstalledPlugin[];
  /** 当前选用的视频插件 */
  plugin: InstalledPlugin | null;
  facets: FacetValues;
  fields: FieldValues;
  /** 帧槽 key → 画布图片节点 ID */
  frameRefs: Partial<Record<string, string>>;
  /** 画布上可作为帧引用的图片节点 */
  canvasImages: CanvasImageOption[];
  /** @ 引用的画布图片数 */
  imageCount: number;
  onPluginChange: (pluginId: string) => void;
  onFacetsChange: (facets: FacetValues) => void;
  onFieldsChange: (patch: Record<string, string | number | boolean>) => void;
  onFrameRefChange: (patch: Partial<Record<string, string | undefined>>) => void;
}

/** 上层未接线视频模式时的空回调，保证新 props 全可选也能安全渲染。 */
const noop = () => {};

/** 渲染在「编排节点」内部：提示词（@ 引用）+ 生成参数（图片模式复用宿主 GenerationParamsBar，视频模式走插件 ui.schema 驱动的 CanvasVideoConfigSection）+ 生成按钮。 */
export function CanvasConfigNodePanel({
  prompt,
  references,
  config,
  lockResultNodes,
  referenceLimit,
  routeValue,
  routeOptions,
  routeInvalid,
  routesTruncated,
  busy,
  optimizing,
  onPromptChange,
  onConfigChange,
  onToggleLock,
  onRouteChange,
  onSelect,
  onOptimizePrompt,
  onPreview,
  onGenerate,
  // —— 视频模式（由 CanvasEditor 传入；全部可选 + 内部兜底，接线前编译不破） ——
  generationMode,
  onGenerationModeChange,
  videoConfig,
}: {
  prompt: string;
  references: CanvasResourceReference[];
  config: CanvasGenerationConfig;
  lockResultNodes: boolean;
  referenceLimit: { imageCount: number; max: number; exceeded: boolean };
  routeValue: string;
  routeOptions: CanvasPromptRouteOption[];
  routeInvalid: boolean;
  routesTruncated: boolean;
  busy: boolean;
  optimizing: boolean;
  onPromptChange: (value: string) => void;
  onConfigChange: (patch: Partial<CanvasGenerationConfig>) => void;
  onToggleLock: () => void;
  onRouteChange: (value: string) => void;
  onSelect: () => void;
  onOptimizePrompt: () => void;
  onPreview: () => void;
  onGenerate: () => void;
  /** 生成模式（缺省为图片模式） */
  generationMode?: CanvasGenerationMode;
  onGenerationModeChange?: (mode: CanvasGenerationMode) => void;
  /** 视频模式配置；未传或无插件时视频区显示引导文案 */
  videoConfig?: CanvasVideoPanelConfig | null;
}) {
  // —— 视频模式兜底：上层未接线时按图片模式渲染 ——
  const isVideoMode = (generationMode ?? "image") === "video";

  // 内存素材：面板统一订阅（useSyncExternalStore），视频配置区与状态计算共享同一份快照
  const mediaKey = videoConfig?.configNodeId ?? "";
  const subscribeMedia = useCallback((listener: () => void) => subscribePendingMedia(mediaKey, listener), [mediaKey]);
  const getMediaSnapshot = useCallback(() => getPendingMedia(mediaKey), [mediaKey]);
  const pendingMedia = useSyncExternalStore(subscribeMedia, getMediaSnapshot, () => []);

  // 视频模式阻断原因：素材超限/必填缺失/参数组合无效（提交时 CanvasEditor 会再校验一次）
  const videoBlockedReason = useMemo(() => {
    if (!isVideoMode || !videoConfig?.plugin) return null;
    const { facets, fields } = videoConfig;
    const promptField = findCanvasPromptField(videoConfig.plugin);
    const mergedFields = promptField ? { ...fields, [promptField.key]: prompt } : fields;
    return computeCanvasVideoBlockReason({
      plugin: videoConfig.plugin,
      facets,
      fields: mergedFields,
      imageCount: videoConfig.imageCount,
      frameRefs: videoConfig.frameRefs,
      canvasImageIds: new Set(videoConfig.canvasImages.map(image => image.id)),
      pendingMedia,
    });
  }, [isVideoMode, pendingMedia, prompt, videoConfig]);

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

  // 视频模式的生成按钮：busy 或阻断原因存在时禁用，title 提示原因
  const generateDisabled = isVideoMode
    ? busy || Boolean(videoBlockedReason) || !videoConfig?.plugin
    : busy || routeInvalid || referenceLimit.exceeded;
  const generateTitle = isVideoMode
    ? (busy ? "生成中" : !videoConfig?.plugin ? "未安装视频插件" : videoBlockedReason ?? undefined)
    : routeInvalid ? "所选路线已失效，请重新选择" : undefined;

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-xs" onPointerDown={() => onSelect()}>
      <div className="shrink-0 space-y-1" data-no-drag>
        <Segmented
          value={generationMode ?? "image"}
          onChange={onGenerationModeChange ?? noop}
          options={[
            { value: "image", label: "图片", icon: <ImageIcon />, title: "图片生成：走宿主任务队列" },
            { value: "video", label: "视频", icon: <Film />, title: "视频生成：由已安装的视频插件驱动，按秒计费" },
          ]}
          className="flex w-full"
          size="sm"
        />
        <Select<string>
          value={routeValue}
          onValueChange={onRouteChange}
          options={routeOptions}
          ariaLabel="提示词路线"
          size="sm"
          className={cn("text-xs", routeInvalid && "border-destructive text-destructive")}
          contentClassName="max-w-[32rem]"
        />
        {routesTruncated && <p className="text-[10px] text-muted-foreground">仅显示前 100 条路线</p>}
      </div>

      {/* 滚动区：模式切换 + 提示词 +（视频模式）插件参数与素材槽 */}
      <div
        className={cn("flex min-h-0 flex-1 flex-col gap-2", isVideoMode && "overflow-auto")}
        data-no-drag
      >
        <div
          className={cn(
            "cursor-text rounded-lg border border-input bg-background p-1.5",
            isVideoMode ? "shrink-0" : "min-h-0 flex-1 overflow-auto",
          )}
        >
          <CanvasMentionEditor value={prompt} references={references} onChange={onPromptChange} placeholder="提示词，输入 @ 引用上游节点…" className="min-h-[56px] text-xs" />
        </div>
        {isVideoMode && (
          videoConfig?.plugin ? (
            <CanvasVideoConfigSection
              configNodeId={videoConfig.configNodeId}
              plugin={videoConfig.plugin}
              plugins={videoConfig.plugins}
              facets={videoConfig.facets}
              fields={videoConfig.fields}
              onFacetsChange={videoConfig.onFacetsChange}
              onFieldsChange={videoConfig.onFieldsChange}
              onFrameRefChange={videoConfig.onFrameRefChange}
              frameRefs={videoConfig.frameRefs}
              onPluginChange={videoConfig.onPluginChange}
              canvasImages={videoConfig.canvasImages}
              imageCount={videoConfig.imageCount}
              prompt={prompt}
              pendingMedia={pendingMedia}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-center text-muted-foreground">
              <Film className="size-6 opacity-70" />
              <p className="text-[11px] leading-snug">
                {videoConfig ? "暂无已安装的视频插件" : "视频插件加载中…"}
                <br />
                由管理员将视频插件目录放入服务器后即可在此使用
              </p>
            </div>
          )
        )}
      </div>

      <div className="shrink-0 space-y-2">
        {!isVideoMode && (
          <GenerationParamsBar
            value={value}
            onChange={handleParamsChange}
            size="xs"
          />
        )}
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={onPreview} className="shrink-0" title="预览最终提示词" aria-label="预览最终提示词">
            <Eye className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={onOptimizePrompt}
            disabled={busy || optimizing || !prompt.trim()}
            className="shrink-0 gap-1"
            title="优化提示词（结合连接的上游图片/文字）"
            aria-label="优化提示词"
          >
            {optimizing ? <Spinner className="size-3.5" /> : <Wand2 className="size-3.5" />}
          </Button>
          {!isVideoMode && (
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
          )}
          <Button size="sm" onClick={onGenerate} disabled={generateDisabled} title={generateTitle} className="flex-1">
            {busy ? <Spinner className="size-4" /> : <Sparkles className="size-4" />}
            生成
          </Button>
        </div>
        {!isVideoMode && (
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
        )}
      </div>
    </div>
  );
}
