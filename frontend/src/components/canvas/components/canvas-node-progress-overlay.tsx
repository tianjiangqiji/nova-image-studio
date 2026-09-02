"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AlertCircle, Check, Clock, Hash, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/plugin-media-config";

import { getUploadProgress, subscribeUploadProgress, type CanvasUploadItemProgress } from "../lib/canvas-video-upload-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { Spinner } from "./canvas-ui";

/** 上传在总进度里占的比重（与宿主视频工作台一致：生成通常远比上传久）。 */
const UPLOAD_WEIGHT = 0.4;

/** 无素材时的稳定空数组引用，避免每次渲染换引用 */
const EMPTY_ITEMS: CanvasUploadItemProgress[] = [];

/** 兜底状态文案：各生成态在遮罩里有专属文案（带计数/上游状态），这里只兜未列举的状态。 */
const STATUS_LABELS: Record<string, string> = {
  uploading: "上传素材",
  submitting: "提交中…",
  queued: "排队中",
  processing: "生成中",
  loading: "加载中",
};

type NodeProgressOverlayProps = {
  data: CanvasNodeData;
  status: string;
  onRefreshProgress?: (node: CanvasNodeData) => void | Promise<void>;
};

/** 订阅节点上传进度（模块级 store 的稳定快照；无数据 → 稳定空数组）。 */
function useUploadProgress(nodeId: string): CanvasUploadItemProgress[] {
  // store 只在进度真变时才换快照引用，这里直接透传，不能 map 复制（否则无限重渲染）
  const subscribe = useCallback((onChange: () => void) => subscribeUploadProgress(nodeId, onChange), [nodeId]);
  const getSnapshot = useCallback(() => getUploadProgress(nodeId), [nodeId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return snapshot ?? EMPTY_ITEMS;
}

/** 每秒跳动的时钟（elapsed 用）；遮罩只在生成中挂载，直接常开。 */
function useTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 紧凑版进度条：percent 有真值走定量；上游没给数时走不定动画。 */
function ProgressBar({
  percent,
  tone = "primary",
  indeterminate = false,
  className,
}: {
  percent: number;
  tone?: "primary" | "destructive" | "muted";
  indeterminate?: boolean;
  className?: string;
}) {
  const fillTone = cn(
    tone === "primary" && "bg-primary",
    tone === "destructive" && "bg-destructive",
    tone === "muted" && "bg-muted-foreground/40",
  );

  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-muted", className)}>
      {indeterminate ? (
        <div className={cn("h-full w-2/5 rounded-full animate-progress-indeterminate", fillTone)} />
      ) : (
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-out", fillTone)}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export type NodeProgressSummary = {
  /** 0-1；无素材视为 1（上传段不存在即已「完成」） */
  uploadRatio: number;
  /** videoProgress/100；上游未返回时 null */
  genRatio: number | null;
  /** uploadRatio*0.4 + genRatio*0.6 后 *100；genRatio null 时 null（交给不定动画） */
  totalPercent: number | null;
  uploadDoneCount: number;
  uploadTotalCount: number;
};

/**
 * 上传/生成两段进度的合成（纯函数，便于单测覆盖）。
 * 上传段按字节加权：一个 30MB 的视频和一张 200KB 的图不该各占一半；
 * bytes 总和为 0（拿不到体积）时退化为按完成个数比。与宿主视频工作台同一套算法。
 */
export function computeNodeProgress(
  items: readonly { bytes: number; loaded: number; status: string }[],
  videoProgress?: number | null,
): NodeProgressSummary {
  const uploadTotalCount = items.length;
  const uploadDoneCount = items.filter((item) => item.status === "done").length;
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const loadedBytes = items.reduce((sum, item) => sum + Math.min(item.loaded, item.bytes), 0);
  const uploadRatio = uploadTotalCount === 0 ? 1 : totalBytes > 0 ? loadedBytes / totalBytes : uploadDoneCount / uploadTotalCount;
  const genRatio = typeof videoProgress === "number" ? videoProgress / 100 : null;
  const totalPercent =
    genRatio === null
      ? null
      : uploadTotalCount === 0
        ? genRatio * 100
        : (uploadRatio * UPLOAD_WEIGHT + genRatio * (1 - UPLOAD_WEIGHT)) * 100;
  return { uploadRatio, genRatio, totalPercent, uploadDoneCount, uploadTotalCount };
}

/**
 * 节点生成进度遮罩：图片与视频节点共用。
 * 视频节点额外展示上传明细（逐素材字节进度）与上游真实进度；上游未返回进度时
 * 进度条走不定动画，绝不用时间估算顶替。
 */
export function NodeProgressOverlay({ data, status, onRefreshProgress }: NodeProgressOverlayProps) {
  const startedAt = data.metadata?.generationStartedAt;
  const taskId = data.metadata?.generationTaskId;
  const isVideo = data.type === CanvasNodeType.Video;
  const items = useUploadProgress(data.id);
  const now = useTicker();

  const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const videoProgress = data.metadata?.videoProgress;
  const summary = computeNodeProgress(items, videoProgress);

  const uploadingCount = items.filter((item) => item.status === "uploading").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  // 状态行：视频优先展示上游感知的细节；图片保持原有简洁文案
  const statusText =
    isVideo && items.length > 0
      ? status === "uploading" && uploadingCount > 0
        ? `上传素材 ${uploadingCount}/${items.length}`
        : summary.uploadDoneCount < summary.uploadTotalCount
          ? `已上传 ${summary.uploadDoneCount}/${summary.uploadTotalCount}`
          : STATUS_LABELS[status] || "生成中"
      : STATUS_LABELS[status] || "生成中";

  const [refreshing, setRefreshing] = useState(false);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 p-3 backdrop-blur-sm" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
      <Spinner className="size-5 text-primary" />
      <span className="text-xs font-medium text-foreground">{statusText}</span>

      {isVideo && (items.length > 0 || typeof videoProgress === "number") && (
        <div className="w-full max-w-[16rem] space-y-1.5">
          <ProgressBar percent={summary.totalPercent ?? 0} indeterminate={summary.totalPercent === null} />
          {typeof videoProgress === "number" && (
            <p className="text-center text-[10px] text-muted-foreground">上游进度 {Math.round(videoProgress)}%</p>
          )}
        </div>
      )}

      {startedAt && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="size-3" />
          {formatElapsed(elapsed)}
        </span>
      )}
      {taskId && (
        <span className="max-w-[10rem] truncate text-[10px] text-muted-foreground" title={taskId}>
          <Hash className="mr-0.5 inline size-3" />
          {taskId.slice(0, 8)}…
        </span>
      )}

      {/* 上传明细：只在视频节点上传期间展示（done 条目在上传结束后仍有参考价值，保留到终态清理前） */}
      {isVideo && items.length > 0 && status !== "queued" && status !== "processing" && (
        <ul className="w-full max-w-[16rem] space-y-0.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {item.status === "done" ? (
                <Check className="size-3 shrink-0 text-primary" />
              ) : item.status === "failed" ? (
                <AlertCircle className="size-3 shrink-0 text-destructive" />
              ) : (
                <span className={cn("size-3 shrink-0 rounded-full border border-current", item.status === "uploading" && "animate-pulse")} />
              )}
              <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
              <span className={cn("shrink-0", item.status === "failed" && "text-destructive")}>
                {item.status === "done"
                  ? formatBytes(item.bytes || item.loaded)
                  : item.status === "failed"
                    ? "失败"
                    : item.bytes > 0
                      ? `${formatBytes(item.loaded)}/${formatBytes(item.bytes)}`
                      : formatBytes(item.loaded)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {isVideo && failedCount > 0 && (
        <span className="max-w-[16rem] text-[10px] text-destructive">有 {failedCount} 个素材上传失败，任务将被中止</span>
      )}

      {taskId && onRefreshProgress && (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 rounded-lg border border-border bg-background/80 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void Promise.resolve(onRefreshProgress(data)).finally(() => setRefreshing(false));
          }}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          获取当前进度
        </button>
      )}
    </div>
  );
}
