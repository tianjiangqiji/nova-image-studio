'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2, X, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Mode, StoredJob } from '@/lib/job-store';
import { cn } from '@/lib/utils';
import { getModelDisplayName } from '@/lib/model-capabilities';
import { CompletedJobCard } from '@/components/workspace/results/CompletedJobCard';

export type GenerationHistoryFilter = 'all' | 'text-to-image' | 'image-to-image';
export type HistoryClearScope = GenerationHistoryFilter;

const historyFilterOptions: { value: GenerationHistoryFilter; label: string }[] = [
  { value: 'all', label: '同时显示' },
  { value: 'text-to-image', label: '文生图' },
  { value: 'image-to-image', label: '图生图' },
];

function isWaitingJob(job: StoredJob): boolean {
  return job.status === 'processing' || job.status === 'queued' || job.status === '排队中';
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  return now;
}

const WaitingJobCard = memo(function WaitingJobCard({
  job,
  now,
  isChecking,
  cooldownEnd,
  onCancel,
  onCheckStatus,
}: {
  job: StoredJob;
  now: number;
  isChecking: boolean;
  cooldownEnd: number | undefined;
  onCancel: (jobId: string) => void;
  onCheckStatus: (job: StoredJob) => void;
}) {
  const parallelCount = job.parallelCount || 1;
  const statusText = job.status === 'queued' || job.status === '排队中'
    ? '排队中...'
    : job.mode === 'text-to-image'
      ? (parallelCount > 1 ? `生成中 (x${parallelCount})...` : '生成中...')
      : (parallelCount > 1 ? `转换中 (x${parallelCount})...` : '转换中...');
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(job.created_at)) / 1000));

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base text-foreground">&quot;{job.prompt}&quot;</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{statusText}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            已用 <span className="font-mono text-foreground">{elapsedSeconds}</span> 秒 · {getModelDisplayName(job.model)}
          </p>
        </div>
        {job.serverTaskId && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onCheckStatus(job)}
            disabled={isChecking || (cooldownEnd !== undefined && now < cooldownEnd)}
            title="查看进度"
          >
            {isChecking
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <RefreshCw className="w-4 h-4" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onCancel(job.id)}
          title="取消"
          className="text-muted-foreground hover:text-destructive"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
});

function JobsHeader({
  title,
  jobsList,
  hasAnyJobs,
  filter,
  onFilterChange,
  onClearAll,
}: {
  title: string;
  jobsList: StoredJob[];
  hasAnyJobs: boolean;
  filter?: GenerationHistoryFilter;
  onFilterChange?: (filter: GenerationHistoryFilter) => void;
  onClearAll: () => void;
}) {
  if (!hasAnyJobs) return null;

  const completed = jobsList.filter(job => job.status === 'completed').length;
  const queued = jobsList.filter(job => job.status === 'queued' || job.status === '排队中').length;
  const processing = jobsList.filter(job => job.status === 'processing').length;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">
          共 {jobsList.length} 条 · 完成 {completed} · 处理中 {processing} · 排队 {queued}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {filter && onFilterChange && (
          <div className="flex rounded-lg border border-border bg-background p-0.5">
            {historyFilterOptions.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => onFilterChange(option.value)}
                className={cn(
                  'h-6 rounded-md px-2 text-xs transition-colors',
                  filter === option.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={onClearAll} disabled={jobsList.length === 0}>
          清空记录
        </Button>
      </div>
    </div>
  );
}

function useColumnCount(
  ref: React.RefObject<HTMLDivElement | null>,
  wideMode: boolean,
  ready: boolean,
) {
  const [columns, setColumns] = useState(() => (wideMode && ready ? 2 : 1));

  useEffect(() => {
    if (!wideMode || !ready) {
      queueMicrotask(() => setColumns(1));
      return;
    }
    const el = ref.current;
    if (!el) return;

    const compute = () => {
      const width = el.clientWidth;
      setColumns(width >= 1080 ? 3 : width >= 680 ? 2 : 1);
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, wideMode, ready]);

  return wideMode ? columns : 1;
}

function VirtualJobList({
  jobs,
  active,
  wideMode,
  renderJobCard,
}: {
  jobs: StoredJob[];
  active: boolean;
  wideMode: boolean;
  renderJobCard: (job: StoredJob) => React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldRender = active && jobs.length > 0;
  const columns = useColumnCount(parentRef, wideMode, shouldRender);
  const gutter = 16;

  const virtualizer = useVirtualizer({
    count: active ? jobs.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
    lanes: columns,
  });

  if (!shouldRender) return null;

  return (
    <div
      ref={parentRef}
      className={cn('relative virtual-scroll-container', wideMode && 'min-h-0 flex-1')}
      style={{
        height: wideMode ? undefined : (jobs.length > 3 ? '70vh' : 'auto'),
        maxHeight: wideMode ? undefined : '70vh',
        minHeight: jobs.length > 0 ? '200px' : '0',
        overflow: 'auto',
        overflowX: 'hidden',
        paddingTop: '8px',
      }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => {
          const lane = columns > 1 ? virtualRow.lane : 0;
          return (
            <div
              key={jobs[virtualRow.index].id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0"
              style={{
                left: `${(100 / columns) * lane}%`,
                width: `${100 / columns}%`,
                paddingLeft: columns > 1 ? gutter / 2 : 0,
                paddingRight: columns > 1 ? gutter / 2 : 0,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div className="mb-4">
                {renderJobCard(jobs[virtualRow.index])}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HistoryJobListProps {
  active: boolean;
  wideMode?: boolean;
  title: string;
  mode: Mode;
  historyFilter?: GenerationHistoryFilter;
  hasAnyJobs?: boolean;
  emptyDescription?: string;
  jobs: StoredJob[];
  loadedImages: Set<string>;
  checkingJobIds: Set<string>;
  cooldowns: Map<string, number>;
  onRetry: (job: StoredJob) => void;
  onRetryDownload?: (job: StoredJob) => void | Promise<void>;
  onClear: (jobId: string) => void;
  onClearAll: (scope: HistoryClearScope) => void;
  onHistoryFilterChange?: (filter: GenerationHistoryFilter) => void;
  onCancel: (jobId: string) => void;
  onCheckStatus: (job: StoredJob) => void;
}

export function HistoryJobList({
  active,
  wideMode = false,
  title,
  mode,
  historyFilter,
  hasAnyJobs,
  emptyDescription,
  jobs,
  loadedImages,
  checkingJobIds,
  cooldowns,
  onRetry,
  onRetryDownload,
  onClear,
  onClearAll,
  onHistoryFilterChange,
  onCancel,
  onCheckStatus,
}: HistoryJobListProps) {
  const hasActiveTimers = useMemo(() => active && jobs.some(job => isWaitingJob(job)), [active, jobs]);
  const now = useNow(hasActiveTimers);
  const clearScope: HistoryClearScope = historyFilter || (mode === 'image-to-image' ? 'image-to-image' : 'text-to-image');

  const renderJobCard = (job: StoredJob) => {
    const hasImage = job.status === 'completed' && (job.images || job.imageData) && loadedImages.has(job.id);
    if (isWaitingJob(job)) {
      return <WaitingJobCard job={job} now={now} isChecking={checkingJobIds.has(job.id)} cooldownEnd={cooldowns.get(job.id)} onCancel={onCancel} onCheckStatus={onCheckStatus} />;
    }
    if (hasImage) {
      return <CompletedJobCard job={job} onClear={() => onClear(job.id)} onRetry={onRetry} onRetryDownload={onRetryDownload} />;
    }
    if (job.status === 'failed') {
      // terminal=true → 后端明确判定不可恢复，不显示"查看进度"
      // 其他情况（默认 / 网络错误 / 未分类）都允许"查看进度"，让用户兜底
      const allowCheckStatus = !job.terminal && !!job.serverTaskId;
      return (
        <div className="rounded-xl border border-destructive/20 bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-base text-foreground">&quot;{job.prompt}&quot;</p>
              <p className="max-h-20 overflow-y-auto text-sm text-destructive">{job.error || '任务失败'}</p>
              <p className="text-xs text-muted-foreground">{getModelDisplayName(job.model)}</p>
            </div>
            <div className="flex gap-1">
              {allowCheckStatus && (
                <Button variant="ghost" size="icon-sm" onClick={() => onCheckStatus(job)} disabled={checkingJobIds.has(job.id) || (cooldowns.get(job.id) !== undefined && now < cooldowns.get(job.id)!)} title="查看进度">
                  {checkingJobIds.has(job.id)
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <RefreshCw className="w-4 h-4" />}
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => onRetry(job)} title="重试">
                <Loader2 className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => onClear(job.id)} title="删除">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <section className={cn(wideMode ? 'flex h-full min-h-0 flex-col space-y-4' : 'space-y-3')}>
      <JobsHeader
        title={title}
        jobsList={jobs}
        hasAnyJobs={hasAnyJobs ?? jobs.length > 0}
        filter={historyFilter}
        onFilterChange={onHistoryFilterChange}
        onClearAll={() => onClearAll(clearScope)}
      />
      {active && jobs.length === 0 ? (
        <div className={cn(
          'flex flex-col items-center justify-center text-center text-muted-foreground',
          wideMode ? 'flex-1 py-16' : 'py-6'
        )}>
          <p className="text-sm">暂无记录</p>
          <p className="mt-1 text-xs opacity-70">
            {emptyDescription || (mode === 'text-to-image' ? '提交一段文字描述来生成图片' : '上传图片并输入描述来转换')}
          </p>
        </div>
      ) : (
        <VirtualJobList jobs={jobs} active={active} wideMode={wideMode} renderJobCard={renderJobCard} />
      )}
    </section>
  );
}
