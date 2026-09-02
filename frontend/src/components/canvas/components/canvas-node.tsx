"use client";

import React, { useEffect, useState } from "react";
import { AlertCircle, Download, FileText, Film, Images, RefreshCw, Save, Sparkles, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { canvasTheme } from "../lib/canvas-theme";
import { formatBytes } from "../lib/image-utils";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { NodeProgressOverlay } from "./canvas-node-progress-overlay";
import { Spinner } from "./canvas-ui";
import { TextAnnotationNodeBody } from "./canvas-node-text-annotation";

export type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const RETRY_COOLDOWN_MS = 3000;

type CanvasNodeProps = {
  data: CanvasNodeData;
  imageUrl?: string;
  isSelected: boolean;
  isRelated: boolean;
  isRouteActive: boolean;
  isConnectionTarget: boolean;
  referenceLimitExceeded?: boolean;
  zIndex: number;
  showImageInfo: boolean;
  onPointerDownNode: (event: React.PointerEvent, nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
  onConnectStart: (event: React.PointerEvent, nodeId: string, handleType: "source" | "target") => void;
  onResizeStart: (event: React.PointerEvent, nodeId: string, corner: ResizeCorner) => void;
  onTitleChange: (nodeId: string, title: string) => void;
  onContentChange: (nodeId: string, content: string) => void;
  onUploadToNode?: (nodeId: string) => void;
  onImportToNode?: (nodeId: string) => void;
  onImportTextToNode?: (nodeId: string) => void;
  onSaveToAssets?: (node: CanvasNodeData) => void;
  onSaveTextToAssets?: (node: CanvasNodeData) => void;
  onRetry?: (node: CanvasNodeData) => void;
  onRefreshProgress?: (node: CanvasNodeData) => void | Promise<void>;
  onOpenImage?: (node: CanvasNodeData) => void;
  onAiGenerate?: (nodeId: string) => void;
  onToggleRenderMode?: (nodeId: string) => void;
  renderPanel?: (node: CanvasNodeData, onSelect: () => void) => React.ReactNode;
};

export const CanvasNode = React.memo(function CanvasNode({
  data,
  imageUrl,
  isSelected,
  isRelated,
  isRouteActive,
  isConnectionTarget,
  referenceLimitExceeded = false,
  zIndex,
  showImageInfo,
  onPointerDownNode,
  onSelectNode,
  onContextMenu,
  onConnectStart,
  onResizeStart,
  onTitleChange,
  onContentChange,
  onUploadToNode,
  onImportToNode,
  onImportTextToNode,
  onSaveToAssets,
  onSaveTextToAssets,
  onRetry,
  onRefreshProgress,
  onOpenImage,
  onAiGenerate,
  onToggleRenderMode,
  renderPanel,
}: CanvasNodeProps) {
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const theme = canvasTheme;
  const status = data.metadata?.status ?? "idle";
  const borderColor = referenceLimitExceeded ? "var(--destructive)" : isSelected || isConnectionTarget || isRouteActive ? theme.node.activeStroke : isRelated ? theme.node.muted : theme.node.stroke;
  const boxShadow = referenceLimitExceeded
    ? "0 0 0 4px color-mix(in srgb, var(--destructive) 18%, transparent)"
    : isSelected
      ? `0 0 0 4px color-mix(in srgb, ${theme.node.activeStroke} 18%, transparent)`
      : isRouteActive
        ? `0 0 0 3px color-mix(in srgb, ${theme.node.activeStroke} 12%, transparent)`
        : undefined;

  return (
    <div
      data-node-id={data.id}
      data-selected={isSelected || undefined}
      data-route-active={isRouteActive || undefined}
      className="group absolute [&_button]:cursor-pointer"
      style={{ left: data.position.x, top: data.position.y, width: data.width, height: data.height, zIndex }}
      onPointerDown={(event) => onPointerDownNode(event, data.id)}
      onContextMenu={(event) => onContextMenu(event, data.id)}
    >
      <div
        className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-2 shadow-sm transition-[border-color,box-shadow]"
        style={{ borderColor, background: theme.node.fill, boxShadow }}
      >
        <div
          className="flex min-h-7 items-center gap-2 px-2.5 py-1 text-[11px] font-medium"
          style={{ color: theme.node.label }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setTitleDraft(data.title);
          }}
          title={titleDraft === null ? "双击重命名节点" : undefined}
        >
          {titleDraft === null ? (
            <span className="truncate">{data.title}</span>
          ) : (
            <input
              autoFocus
              aria-label="节点标题"
              data-canvas-no-zoom="true"
              value={titleDraft}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTitleDraft(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onBlur={() => {
                const nextTitle = titleDraft.trim();
                setTitleDraft(null);
                if (nextTitle && nextTitle !== data.title) onTitleChange(data.id, nextTitle);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  const nextTitle = titleDraft.trim();
                  setTitleDraft(null);
                  if (nextTitle && nextTitle !== data.title) onTitleChange(data.id, nextTitle);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setTitleDraft(null);
                }
              }}
              className="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-[11px] font-medium text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring/40"
            />
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          {data.type === CanvasNodeType.Image ? (
            <ImageNodeBody data={data} imageUrl={imageUrl} status={status} showImageInfo={showImageInfo} onUploadToNode={onUploadToNode} onImportToNode={onImportToNode} onSaveToAssets={onSaveToAssets} onRetry={onRetry} onRefreshProgress={onRefreshProgress} onOpenImage={onOpenImage} />
          ) : data.type === CanvasNodeType.Video ? (
            <VideoNodeBody data={data} status={status} onRetry={onRetry} onRefreshProgress={onRefreshProgress} />
          ) : data.type === CanvasNodeType.Text ? (
            <TextNodeBody data={data} onContentChange={onContentChange} onSelectNode={onSelectNode} onImportTextToNode={onImportTextToNode} onSaveTextToAssets={onSaveTextToAssets} onAiGenerate={onAiGenerate} onToggleRenderMode={onToggleRenderMode} />
          ) : data.type === CanvasNodeType.TextAnnotation ? (
            <TextAnnotationNodeBody data={data} onContentChange={onContentChange} onSelectNode={onSelectNode} />
          ) : (
            <div className="h-full w-full" data-canvas-no-zoom>
              {renderPanel?.(data, () => onSelectNode(data.id))}
            </div>
          )}

          {/* 通用 loading overlay（非图片节点的旧式 loading） */}
          {status === "loading" && data.type !== CanvasNodeType.Image && (
            <div className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-sm">
              <Spinner className="size-6 text-primary" />
            </div>
          )}
        </div>
      </div>

      {/* 连接手柄：选中常驻 / 悬停显示，命中区域更大 */}
      <button
        type="button"
        aria-label="连接输出"
        className={cn(
          "absolute top-1/2 -right-3.5 grid size-7 -translate-y-1/2 place-items-center transition-opacity",
          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        onPointerDown={(event) => {
          event.stopPropagation();
          onConnectStart(event, data.id, "source");
        }}
      >
        <span className="size-3 rounded-full border-2 border-background bg-primary shadow-sm" />
      </button>
      <button
        type="button"
        aria-label="连接输入"
        className={cn(
          "absolute top-1/2 -left-3.5 grid size-7 -translate-y-1/2 place-items-center transition-opacity",
          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        onPointerDown={(event) => {
          event.stopPropagation();
          onConnectStart(event, data.id, "target");
        }}
      >
        <span className="size-3 rounded-full border-2 border-background bg-muted-foreground shadow-sm" />
      </button>

      {/* 缩放手柄：选中显示，命中区域更大 */}
      {isSelected &&
        (["top-left", "top-right", "bottom-left", "bottom-right"] as ResizeCorner[]).map((corner) => (
          <div
            key={corner}
            className={cn(
              "absolute grid size-6 place-items-center",
              corner === "top-left" && "-top-3 -left-3 cursor-nwse-resize",
              corner === "top-right" && "-top-3 -right-3 cursor-nesw-resize",
              corner === "bottom-left" && "-bottom-3 -left-3 cursor-nesw-resize",
              corner === "bottom-right" && "-right-3 -bottom-3 cursor-nwse-resize",
            )}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              onResizeStart(event, data.id, corner);
            }}
          >
            <span className="size-3 rounded-sm border-2 border-primary bg-background shadow-sm" />
          </div>
        ))}
    </div>
  );
});

function ImageNodeBody({
  data,
  imageUrl,
  status,
  showImageInfo,
  onUploadToNode,
  onImportToNode,
  onSaveToAssets,
  onRetry,
  onRefreshProgress,
  onOpenImage,
}: {
  data: CanvasNodeData;
  imageUrl?: string;
  status: string;
  showImageInfo: boolean;
  onUploadToNode?: (nodeId: string) => void;
  onImportToNode?: (nodeId: string) => void;
  onSaveToAssets?: (node: CanvasNodeData) => void;
  onRetry?: (node: CanvasNodeData) => void;
  onRefreshProgress?: (node: CanvasNodeData) => void | Promise<void>;
  onOpenImage?: (node: CanvasNodeData) => void;
}) {
  const [refreshingCache, setRefreshingCache] = useState(false);
  const fallbackContent = data.metadata?.content;
  // 不渲染刷新后失效的 blob: URL（避免 ERR_FILE_NOT_FOUND）；由上层 imageUrl（storageKey 解析）提供有效地址
  const url = imageUrl || (fallbackContent && !fallbackContent.startsWith("blob:") ? fallbackContent : undefined);
  const isGenerating = status === "submitting" || status === "queued" || status === "processing";
  const isError = status === "error";

  return (
    <div className="relative h-full w-full">
      {/* 有图片时显示图片 */}
      {url && (
        <img src={url} alt={data.title} className="h-full w-full object-contain" draggable={false} onDoubleClick={() => onOpenImage?.(data)} />
      )}

      {/* 空状态：无图片且不在生成中 */}
      {!url && !isGenerating && !isError && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground" data-canvas-no-zoom>
          <Images className="size-6 opacity-70" />
          <p className="max-w-[15rem] text-[11px] leading-snug">该节点可作为参考图或目标图节点</p>
          <div className="mt-1 flex flex-row items-center justify-center gap-2">
            <button type="button" className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted" onClick={() => onUploadToNode?.(data.id)}>
              <Upload className="size-3.5" />
              上传图片
            </button>
            <button type="button" className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted" onClick={() => onImportToNode?.(data.id)}>
              <Images className="size-3.5" />
              从素材库导入
            </button>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {isError && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
          <AlertCircle className="size-6 text-destructive" />
          <span className="line-clamp-3 text-xs text-destructive">{data.metadata?.errorDetails || "生成失败"}</span>
          {onRetry && <RetryButton onRetry={() => onRetry(data)} />}
        </div>
      )}

      {/* 生成中 overlay（覆盖在图片上方，图片可能已有一部分） */}
      {isGenerating && <NodeProgressOverlay data={data} status={status} onRefreshProgress={onRefreshProgress} />}

      {/* 存素材按钮（仅在有图片且非生成中时显示） */}
      {url && !isGenerating && onSaveToAssets && (
        <button
          type="button"
          data-canvas-no-zoom
          title="存入我的素材"
          className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 text-[10px] text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSaveToAssets(data)}
        >
          <Save className="size-3.5" />
          存素材
        </button>
      )}

      {url && !isGenerating && data.metadata?.generationTaskId && (data.metadata?.resultCacheStatus === "pending" || data.metadata?.resultCacheStatus === "failed") && onRefreshProgress && (
        <button
          type="button"
          data-canvas-no-zoom
          aria-label="重新获取原图"
          title={data.metadata?.resultCacheError || "重新获取并保存原图"}
          disabled={refreshingCache}
          className="absolute right-1.5 bottom-1.5 grid size-7 place-items-center rounded-md bg-amber-600/90 text-white shadow-sm transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setRefreshingCache(true);
            void Promise.resolve(onRefreshProgress(data)).finally(() => setRefreshingCache(false));
          }}
        >
          <RefreshCw className={cn("size-3.5", refreshingCache && "animate-spin")} />
        </button>
      )}

      {/* 图片信息（尺寸/大小） */}
      {url && !isGenerating && showImageInfo && (data.metadata?.naturalWidth || data.metadata?.bytes) && (
        <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
          {data.metadata?.naturalWidth ? `${data.metadata.naturalWidth}×${data.metadata.naturalHeight}` : ""} {data.metadata?.bytes ? formatBytes(data.metadata.bytes) : ""}
        </div>
      )}
    </div>
  );
}

/** Video 结果节点体：成功内联播放 / 链接过期兜底 / 错误 / 空态 / 生成中进度遮罩。 */
function VideoNodeBody({
  data,
  status,
  onRetry,
  onRefreshProgress,
}: {
  data: CanvasNodeData;
  status: string;
  onRetry?: (node: CanvasNodeData) => void;
  onRefreshProgress?: (node: CanvasNodeData) => void | Promise<void>;
}) {
  const videoUrl = data.metadata?.videoUrl;
  const posterUrl = data.metadata?.videoPosterUrl;
  const isGenerating = ["uploading", "submitting", "queued", "processing"].includes(status);
  const isError = status === "error";
  // 上游直链数小时后过期：<video> 加载失败时切入过期态；新任务成功写入新 videoUrl 后复位。
  // 复位用渲染期「prop 变化调整 state」写法（React 官方推荐），而不是 effect 里 setState
  const [expired, setExpired] = useState(false);
  const [prevUrl, setPrevUrl] = useState(videoUrl);
  if (prevUrl !== videoUrl) {
    setPrevUrl(videoUrl);
    setExpired(false);
  }

  const durationText = typeof data.metadata?.videoDurationSec === "number" ? `${Math.round(data.metadata.videoDurationSec)}s` : "";
  const badgeText = durationText;

  return (
    <div className="relative h-full w-full">
      {/* 成功态：内联播放器。controls 区域要能交互，故阻止 pointer 冒泡（不触发节点拖拽/框选） */}
      {videoUrl && !expired && (
        <div className="h-full w-full" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
          <video
            src={videoUrl}
            poster={posterUrl}
            controls
            preload="metadata"
            className="h-full w-full object-contain"
            draggable={false}
            onError={() => setExpired(true)}
          />
        </div>
      )}

      {/* 过期态：有封面用封面兜底，叠提示 + 重新生成；无封面纯提示 */}
      {videoUrl && expired && !isGenerating && (
        <div className="absolute inset-0" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
          {posterUrl && <img src={posterUrl} alt={data.title} className="h-full w-full object-contain" draggable={false} />}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 p-3 text-center backdrop-blur-sm">
            <AlertCircle className="size-6 text-destructive" />
            <span className="text-xs text-foreground">视频链接已过期（上游仅保留数小时）</span>
            {onRetry && <RetryButton onRetry={() => onRetry(data)} />}
          </div>
        </div>
      )}

      {/* 错误态 */}
      {isError && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
          <AlertCircle className="size-6 text-destructive" />
          <span className="line-clamp-3 text-xs text-destructive">{data.metadata?.errorDetails || "生成失败"}</span>
          {onRetry && <RetryButton onRetry={() => onRetry(data)} />}
        </div>
      )}

      {/* 空态：等待编排节点生成 */}
      {!videoUrl && !isGenerating && !isError && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground" data-canvas-no-zoom>
          <Film className="size-6 opacity-70" />
          <p className="text-[11px] leading-snug">视频生成结果节点</p>
        </div>
      )}

      {/* 生成中遮罩（可能盖在旧结果上，如重新生成场景） */}
      {isGenerating && <NodeProgressOverlay data={data} status={status} onRefreshProgress={onRefreshProgress} />}

      {/* 信息角标：时长（非生成中） */}
      {videoUrl && !expired && !isGenerating && badgeText && (
        <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{badgeText}</div>
      )}

      {/* 下载按钮：hover 出现，新窗口打开直链可另存（样式对齐图片节点的"存素材"） */}
      {videoUrl && !expired && !isGenerating && (
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="下载视频"
          data-canvas-no-zoom
          className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 text-[10px] text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Download className="size-3.5" /> 下载
        </a>
      )}
    </div>
  );
}

/** 重试按钮（带 3s 冷却防连点）。 */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  const [cooldown, setCooldown] = useState(0);

  const handleClick = () => {
    if (cooldown > 0) return;
    onRetry();
    setCooldown(RETRY_COOLDOWN_MS / 1000);
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  return (
    <button
      type="button"
      data-canvas-no-zoom
      className={cn(
        "mt-1 inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
        cooldown > 0 ? "cursor-not-allowed bg-muted text-muted-foreground" : "bg-background text-foreground hover:bg-muted",
      )}
      onClick={handleClick}
      disabled={cooldown > 0}
    >
      <RefreshCw className={cn("size-3.5", cooldown > 0 && "animate-spin")} />
      {cooldown > 0 ? `${cooldown}s` : "重新生成"}
    </button>
  );
}

function TextNodeBody({
  data,
  onContentChange,
  onSelectNode,
  onImportTextToNode,
  onSaveTextToAssets,
  onAiGenerate,
  onToggleRenderMode,
}: {
  data: CanvasNodeData;
  onContentChange: (nodeId: string, content: string) => void;
  onSelectNode: (nodeId: string) => void;
  onImportTextToNode?: (nodeId: string) => void;
  onSaveTextToAssets?: (node: CanvasNodeData) => void;
  onAiGenerate?: (nodeId: string) => void;
  onToggleRenderMode?: (nodeId: string) => void;
}) {
  const content = data.metadata?.content || "";
  const renderMode = data.metadata?.renderMode || "plain";
  const isMarkdown = renderMode === "markdown";

  return (
    <div className="relative h-full w-full">
      {isMarkdown ? (
        <div className="h-full w-full overflow-auto px-2.5 py-1.5 text-sm [&>*:first-child]:mt-0">
          <SimpleMarkdown content={content} />
        </div>
      ) : (
        <textarea
          data-canvas-no-zoom
          value={content}
          onChange={(event) => onContentChange(data.id, event.target.value)}
          placeholder="输入文本…"
          className="h-full w-full cursor-text resize-none bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          style={{ fontSize: data.metadata?.fontSize || 14 }}
          onPointerDown={() => onSelectNode(data.id)}
        />
      )}

      {/* 右上角按钮栏 */}
      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100" data-canvas-no-zoom>
        {onToggleRenderMode && (
          <button
            type="button"
            title={isMarkdown ? "切换为纯文本" : "切换为 Markdown 预览"}
            className="inline-flex items-center justify-center rounded-md bg-background/90 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onToggleRenderMode(data.id)}
          >
            <span className="text-[10px] font-bold">{isMarkdown ? "Tx" : "Md"}</span>
          </button>
        )}
        {onAiGenerate && (
          <button
            type="button"
            title="AI 生成文本"
            className="inline-flex items-center justify-center rounded-md bg-background/90 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onAiGenerate?.(data.id)}
          >
            <Sparkles className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          title="导入提示词素材"
          className="inline-flex items-center justify-center rounded-md bg-background/90 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onImportTextToNode?.(data.id)}
        >
          <FileText className="size-3.5" />
        </button>
        {content.trim() && (
          <button
            type="button"
            title="存为提示词素材"
            className="inline-flex items-center justify-center rounded-md bg-background/90 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onSaveTextToAssets?.(data)}
          >
            <Save className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** 轻量 Markdown 渲染组件（安装 react-markdown 后替换为真实渲染） */
function SimpleMarkdown({ content }: { content: string }) {
  // 预加载 react-markdown（如果已安装则使用，否则 fallback 为纯文本）
  if (typeof content !== "string") return null;
  const lines = content.split("\n");
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      {lines.map((line, i) => {
        if (line.startsWith("# ")) return <h1 key={i} className="text-lg font-bold">{line.slice(2)}</h1>;
        if (line.startsWith("## ")) return <h2 key={i} className="text-base font-bold">{line.slice(3)}</h2>;
        if (line.startsWith("### ")) return <h3 key={i} className="text-sm font-bold">{line.slice(4)}</h3>;
        if (line.startsWith("- ")) return <li key={i} className="ml-4 list-disc text-sm">{line.slice(2)}</li>;
        if (line.startsWith("> ")) return <blockquote key={i} className="border-l-2 border-muted-foreground/30 pl-2 text-sm italic text-muted-foreground">{line.slice(2)}</blockquote>;
        if (line.startsWith("```")) return <pre key={i} className="overflow-x-auto rounded bg-muted p-2 text-xs"><code>{line.slice(3)}</code></pre>;
        if (line === "") return <br key={i} />;
        // 支持 **bold** 和 *italic*
        const processed = line
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/\*(.+?)\*/g, "<em>$1</em>")
          .replace(/`(.+?)`/g, "<code class='rounded bg-muted px-1 text-xs'>$1</code>");
        return <p key={i} className="text-sm" dangerouslySetInnerHTML={{ __html: processed }} />;
      })}
    </div>
  );
}
