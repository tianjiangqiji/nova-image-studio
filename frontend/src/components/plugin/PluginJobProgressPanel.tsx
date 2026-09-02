'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/plugin-media-config';
import {
  getUploadProgress,
  subscribeUploadProgress,
  type UploadItemProgress,
} from '@/lib/plugin-upload-runner';
import type { PluginJob } from '@/lib/plugin-job-store';

/** 上传在总进度里占的比重。剩下的给生成——生成通常远比上传久。 */
const UPLOAD_WEIGHT = 0.4;

/** 无素材时的稳定空数组引用，避免每次渲染换引用 */
const EMPTY_PROGRESS: UploadItemProgress[] = [];

function useUploadProgress(jobId: string): UploadItemProgress[] {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeUploadProgress(jobId, onChange),
    [jobId],
  );
  const getSnapshot = useCallback(() => getUploadProgress(jobId), [jobId]);
  // runner 只在进度真变时才换快照引用，这里直接读它，不能在此处 map 复制
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return snapshot ?? EMPTY_PROGRESS;
}

function useTicker(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

function ProgressBar({
  percent,
  tone = 'primary',
  indeterminate = false,
}: {
  percent: number;
  tone?: 'primary' | 'destructive' | 'muted';
  indeterminate?: boolean;
}) {
  const fillTone = cn(
    tone === 'primary' && 'bg-primary',
    tone === 'destructive' && 'bg-destructive',
    tone === 'muted' && 'bg-muted-foreground/40',
  );

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {indeterminate ? (
        <div className={cn('h-full w-2/5 rounded-full animate-progress-indeterminate', fillTone)} />
      ) : (
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', fillTone)}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      )}
    </div>
  );
}

interface PluginJobProgressPanelProps {
  job: PluginJob;
}

/**
 * 任务进行中的进度面板，内联在历史卡片里。
 * 折叠态给一条总进度 + 状态文案；展开后每个素材一条，最后一条是生成进度。
 *
 * 两段进度都是真数：上传读 XHR 的字节数，生成读上游返回的 progress。
 * 上游没给 progress 的那几轮不显示百分比，改显示已用时间——宁可少说，不编数字。
 */
export function PluginJobProgressPanel({ job }: PluginJobProgressPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const items = useUploadProgress(job.id);
  const isUploading = job.status === 'uploading';
  const isLocalQueued = job.status === 'queued' || job.status === '排队中';
  const isUpstreamQueued = job.upstreamStatus === 'queued';
  const now = useTicker(true);

  // 上传进度按字节加权：一个 30MB 的视频和一张 200KB 的图不该各占一半
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const loadedBytes = items.reduce((sum, item) => sum + Math.min(item.loaded, item.bytes), 0);
  const doneCount = items.filter(item => item.status === 'done').length;
  const uploadRatio = items.length === 0 ? 1 : totalBytes > 0 ? loadedBytes / totalBytes : doneCount / items.length;

  // 上游真实进度。上传阶段还没交给上游，按 0 算
  const genRatio = isUploading ? 0 : typeof job.progress === 'number' ? job.progress / 100 : null;
  const genUnknown = !isUploading && genRatio === null;

  // 生成段拿不到真值时整条就没有百分比可言，交给不定量动画
  const totalPercent = genUnknown
    ? null
    : items.length === 0
      ? genRatio! * 100
      : (uploadRatio * UPLOAD_WEIGHT + genRatio! * (1 - UPLOAD_WEIGHT)) * 100;

  const generateStartedAt = job.generationStartedAt ? Date.parse(job.generationStartedAt) : null;
  const elapsedText = generateStartedAt ? formatDuration(now - generateStartedAt) : null;

  const statusText = isUploading
    ? `上传素材 ${doneCount}/${items.length}`
    : isLocalQueued
      ? '本机排队等待中'
      : isUpstreamQueued
        ? '上游排队等待中'
        : 'AI 正在生成';

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-3">
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        <span className="text-xs font-medium text-foreground">{statusText}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {totalPercent === null ? (elapsedText ?? '进行中') : `${Math.round(totalPercent)}%`}
        </span>
        {items.length > 0 && (expanded
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />)}
      </button>

      <div className="mt-2">
        <ProgressBar percent={totalPercent ?? 0} indeterminate={totalPercent === null} />
      </div>

      {expanded && items.length > 0 && (
        <div className="mt-3 space-y-2">
          {items.map(item => {
            const percent = item.status === 'done'
              ? 100
              : item.bytes > 0 ? (item.loaded / item.bytes) * 100 : 0;
            return (
              <div key={item.id} className="space-y-1">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={item.name}>
                    {item.name}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(item.bytes)}</span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                    {item.status === 'done' && <Check className="ml-auto size-3.5 text-emerald-600" />}
                    {item.status === 'failed' && <AlertCircle className="ml-auto size-3.5 text-destructive" />}
                    {item.status === 'uploading' && `${Math.round(percent)}%`}
                    {item.status === 'pending' && '等待'}
                  </span>
                </div>
                <ProgressBar
                  percent={percent}
                  tone={item.status === 'failed' ? 'destructive' : item.status === 'pending' ? 'muted' : 'primary'}
                />
                {item.error && <p className="text-[10px] text-destructive">{item.error}</p>}
              </div>
            );
          })}

          <div className="space-y-1 border-t border-border/40 pt-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="min-w-0 flex-1 text-foreground">生成进度</span>
              <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                {isUploading ? '等待' : genUnknown ? (elapsedText ?? '进行中') : `${Math.round(genRatio! * 100)}%`}
              </span>
            </div>
            <ProgressBar
              percent={(genRatio ?? 0) * 100}
              tone={isUploading ? 'muted' : 'primary'}
              indeterminate={genUnknown}
            />
            {genUnknown && (
              <p className="text-[10px] text-muted-foreground">上游本轮未返回进度百分比</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
}

/**
 * 上传 / 生成用时。进行中每秒跳动，终态后读时间戳静态显示，刷新页面依然在。
 * 缺时间戳的旧记录（本次改动之前创建的）对应段直接不显示，不用 Date.now() 倒推假数据。
 */
export function PluginJobTimings({ job, live }: { job: PluginJob; live: boolean }) {
  const now = useTicker(live);

  const uploadStart = job.uploadStartedAt ? Date.parse(job.uploadStartedAt) : null;
  const uploadEnd = job.uploadCompletedAt ? Date.parse(job.uploadCompletedAt) : null;
  const generateStart = job.generationStartedAt ? Date.parse(job.generationStartedAt) : null;
  const finishedAt = job.completedAt ? Date.parse(job.completedAt) : null;

  const parts: string[] = [];
  if (uploadStart) {
    const end = uploadEnd ?? (job.status === 'uploading' ? now : null);
    if (end) parts.push(`上传 ${formatDuration(end - uploadStart)}`);
  }
  if (generateStart) {
    const end = finishedAt ?? now;
    parts.push(`生成 ${formatDuration(end - generateStart)}`);
  }

  if (parts.length === 0) return null;
  return <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{parts.join(' · ')}</span>;
}
