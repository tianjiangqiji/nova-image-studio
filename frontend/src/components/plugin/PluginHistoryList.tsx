'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Film,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  Video,
  VolumeX,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  clearPluginJobs,
  getPluginJobsServerSnapshot,
  getPluginJobsSnapshot,
  isActivePluginJob,
  loadPluginJobs,
  primaryAsset,
  removePluginJob,
  subscribePluginJobs,
  updatePluginJob,
  updatePluginSubTask,
  type PluginJob,
} from '@/lib/plugin-job-store';
import { ackPluginTask, getPluginTask, probeMediaUrl } from '@/lib/plugin-task-client';
import { canRetry, reconcileInterruptedUploads, retryPluginJob } from '@/lib/plugin-upload-runner';
import { PluginJobProgressPanel, PluginJobTimings } from '@/components/plugin/PluginJobProgressPanel';

interface PluginHistoryListProps {
  wideMode?: boolean;
  active?: boolean;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  onReuseParams?: (job: PluginJob) => void;
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€' };

/**
 * 插件任务的历史记录。
 *
 * 只认宿主归一化后的产物结构（PluginJob.assets），不认识任何具体插件——
 * 所以插件被卸载后，旧记录依然能预览、下载、复制提示词。
 */
export function PluginHistoryList({
  wideMode = false,
  active = true,
  showToast,
  onReuseParams,
}: PluginHistoryListProps) {
  const jobs = useSyncExternalStore(
    subscribePluginJobs,
    getPluginJobsSnapshot,
    getPluginJobsServerSnapshot,
  );
  const [filter, setFilter] = useState<'all' | 'processing' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [previewJob, setPreviewJob] = useState<PluginJob | null>(null);
  const [expiredJob, setExpiredJob] = useState<PluginJob | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  // 预览状态：当前预览的视频索引、预览模式（单屏/分屏）、分屏时另一个视频的索引
  const [previewIndex, setPreviewIndex] = useState(0);
  const [splitIndex, setSplitIndex] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<'single' | 'split'>('single');

  // 页面刷新会丢掉内存里待上传的 File，把停在 uploading 的任务标失败，避免永远转圈
  useEffect(() => {
    reconcileInterruptedUploads();
  }, []);

  const pollingRef = useRef(false);
  const pollActiveJobs = useCallback(async () => {
    if (pollingRef.current) return;
    // uploading 阶段还没有 serverTaskId，由 runner 自己驱动，这里只管已提交到后端的
    const activeJobs = loadPluginJobs().filter(job => isActivePluginJob(job) && (job.serverTaskId || job.subTasks?.some(st => st.serverTaskId)));
    if (activeJobs.length === 0) return;

    pollingRef.current = true;
    try {
      for (const job of activeJobs) {
        // 并发子任务模式：轮询每个子任务
        if (job.subTasks && job.subTasks.length > 0) {
          for (const sub of job.subTasks) {
            if (!sub.serverTaskId || sub.serverTaskId.startsWith('failed_')) continue;
            if (sub.status === 'completed' || sub.status === 'failed') continue;
            try {
              const res = await getPluginTask(sub.serverTaskId);
              if (res.status === 'completed') {
                updatePluginSubTask(job.id, sub.serverTaskId, {
                  status: 'completed',
                  assets: res.result?.assets?.length ? res.result.assets : sub.assets,
                  completedAt: new Date().toISOString(),
                  progress: 100,
                  upstreamStatus: 'completed',
                });
                void ackPluginTask(sub.serverTaskId);
              } else if (res.status === 'failed' || res.status === 'expired') {
                updatePluginSubTask(job.id, sub.serverTaskId, {
                  status: 'failed',
                  error: res.error || '生成失败',
                  completedAt: new Date().toISOString(),
                });
              } else {
                const nextStatus = res.status === 'queued' || res.status === '排队中' ? 'queued' : 'processing';
                const nextProgress = typeof res.progress === 'number' ? res.progress : undefined;
                updatePluginSubTask(job.id, sub.serverTaskId, {
                  status: nextStatus,
                  progress: nextProgress,
                  upstreamStatus: res.upstreamStatus,
                });
              }
            } catch (err) {
              console.warn(`[PluginHistoryList] 轮询子任务 ${sub.serverTaskId} 错误:`, err);
            }
          }
          // 检查是否全部完成
          const updatedJob = loadPluginJobs().find(j => j.id === job.id);
          if (updatedJob?.status === 'completed' && updatedJob.subTasks) {
            const successCount = updatedJob.subTasks.filter(st => st.status === 'completed').length;
            showToast?.(`并发任务全部完成（成功 ${successCount}/${updatedJob.subTasks.length}）`, 'success');
          }
        } else if (job.serverTaskId) {
          // 单任务模式（原有逻辑）
          try {
            const res = await getPluginTask(job.serverTaskId);
            if (res.status === 'completed') {
              updatePluginJob(job.id, {
                status: 'completed',
                assets: res.result?.assets?.length ? res.result.assets : job.assets,
                completedAt: new Date().toISOString(),
                progress: 100,
                upstreamStatus: 'completed',
              });
              void ackPluginTask(job.serverTaskId);
              showToast?.('生成成功！', 'success');
            } else if (res.status === 'failed' || res.status === 'expired') {
              updatePluginJob(job.id, {
                status: 'failed',
                error: res.error || '生成失败',
                completedAt: new Date().toISOString(),
              });
              showToast?.(res.error || '生成失败', 'error');
            } else {
              // 本机队列状态与上游进度都可能变，逐字段比对后再写——每 5 秒无脑写一次
              // localStorage 会让整个历史列表跟着重渲染
              const nextStatus = res.status === 'queued' || res.status === '排队中' ? 'queued' : 'processing';
              const nextProgress = typeof res.progress === 'number' ? res.progress : undefined;
              if (
                job.status !== nextStatus
                || job.progress !== nextProgress
                || job.upstreamStatus !== res.upstreamStatus
              ) {
                updatePluginJob(job.id, {
                  status: nextStatus,
                  progress: nextProgress,
                  upstreamStatus: res.upstreamStatus,
                });
              }
            }
          } catch (error) {
            console.warn(`[PluginHistoryList] 轮询任务 ${job.id} 错误:`, error);
          }
        }
      }
    } finally {
      pollingRef.current = false;
    }
  }, [showToast]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void pollActiveJobs(), 5000);
    void pollActiveJobs();
    return () => clearInterval(timer);
  }, [active, pollActiveJobs]);

  const handleCopy = useCallback(async (
    text: string,
    setter: (id: string | null) => void,
    id: string,
    label: string,
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(id);
      showToast?.(`${label}已复制到剪贴板`, 'success');
      setTimeout(() => setter(null), 2000);
    } catch {
      showToast?.('复制失败，请手动复制', 'error');
    }
  }, [showToast]);

  /**
   * 上游产物直链通常只保留数小时，且响应里没有过期时间字段，只能在用户真的要看/要下载时
   * 探一次。探测失败就问要不要删记录——不自动删，用户可能还想复制提示词或重用参数。
   */
  const ensureUsable = useCallback(async (job: PluginJob): Promise<boolean> => {
    const asset = primaryAsset(job);
    if (!asset?.url) return false;
    setProbingId(job.id);
    try {
      const alive = await probeMediaUrl(asset.url);
      if (!alive) setExpiredJob(job);
      return alive;
    } finally {
      setProbingId(null);
    }
  }, []);

  const handlePreview = useCallback(async (job: PluginJob) => {
    if (await ensureUsable(job)) {
      // 找到该 job 在已完成列表中的索引
      const completedJobs = jobs.filter(j => j.status === 'completed' && primaryAsset(j)?.url);
      const idx = completedJobs.findIndex(j => j.id === job.id);
      setPreviewIndex(idx >= 0 ? idx : 0);
      setSplitIndex(null);
      setPreviewMode('single');
      setPreviewJob(job);
    }
  }, [ensureUsable, jobs]);

  const handleDownload = useCallback(async (job: PluginJob) => {
    const asset = primaryAsset(job);
    if (!asset?.url) return;
    if (!(await ensureUsable(job))) return;
    setDownloadingId(job.id);
    try {
      const filename = `${job.pluginId}_${job.model}_${Date.now()}.mp4`;
      const response = await fetch(asset.url, { mode: 'cors' }).catch(() => null);
      if (response && response.ok) {
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(blobUrl);
      } else {
        // 跨域拿不到 blob 时退回直接下载
        const anchor = document.createElement('a');
        anchor.href = asset.url;
        anchor.download = filename;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      }
      showToast?.('开始下载', 'success');
    } catch {
      window.open(asset.url, '_blank');
    } finally {
      setDownloadingId(null);
    }
  }, [ensureUsable, showToast]);

  const filteredJobs = useMemo(() => jobs.filter(job => {
    if (filter === 'processing' && !isActivePluginJob(job)) return false;
    if (filter === 'completed' && job.status !== 'completed') return false;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      return job.prompt.toLowerCase().includes(query)
        || job.modelLabel.toLowerCase().includes(query)
        || job.pluginName.toLowerCase().includes(query);
    }
    return true;
  }), [jobs, filter, searchQuery]);

  const activeCount = jobs.filter(isActivePluginJob).length;

  return (
    <div className={cn('flex flex-col', wideMode && 'h-full min-h-0')}>
      {/* 单张卡片内包含标题、筛选与全部历史记录 */}
      <section
        className={cn(
          'flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm',
          wideMode && 'h-full min-h-0',
        )}
      >
        <div className="flex flex-col items-start justify-between gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Film className="size-5" />
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                视频生成历史
                {activeCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
                    <Loader2 className="size-3 animate-spin" />
                    {activeCount} 个进行中
                  </span>
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                共 {jobs.length} 条记录 · 生成后请及时下载保存到本地设备
              </p>
            </div>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative flex-1 sm:w-44">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="搜索提示词、模型或插件..."
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                className="h-8 rounded-xl pl-8 pr-3 text-xs"
              />
            </div>

            <div className="flex items-center rounded-xl border border-border bg-muted/60 p-0.5 text-xs">
              {([
                { value: 'all', label: '全部' },
                { value: 'processing', label: '进行中' },
                { value: 'completed', label: '已完成' },
              ] as const).map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 font-medium transition-colors',
                    filter === option.value
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {jobs.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setClearDialogOpen(true)}
                className="h-8 rounded-xl px-2.5 text-xs text-muted-foreground hover:text-destructive"
                title="清空所有记录"
              >
                <Trash2 className="mr-1 size-3.5" />
                清空
              </Button>
            )}
          </div>
        </div>

        <div className={cn('flex flex-col gap-3 p-4', wideMode && 'min-h-0 flex-1 overflow-y-auto')}>
          {filteredJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-12 text-center">
              <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Video className="size-6" />
              </div>
              <h4 className="text-sm font-semibold text-foreground">
                {jobs.length === 0 ? '暂无视频任务' : '没有匹配的记录'}
              </h4>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                {jobs.length === 0
                  ? '在左侧选择插件与参数、填写提示词，点击「开始生成」即可创建任务。'
                  : '试试换个关键词或切换筛选条件。'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredJobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  copiedId={copiedId}
                  copiedPromptId={copiedPromptId}
                  downloadingId={downloadingId}
                  probingId={probingId}
                  onCopyLink={url => void handleCopy(url, setCopiedId, job.id, '链接')}
                  onCopyPrompt={() => void handleCopy(job.prompt, setCopiedPromptId, job.id, '提示词')}
                  onPreview={() => void handlePreview(job)}
                  onDownload={() => void handleDownload(job)}
                  onReuseParams={onReuseParams}
                  onRemove={() => removePluginJob(job.id)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 预览播放器：支持左右切换、分屏同时播放 */}
      <Dialog open={Boolean(previewJob)} onOpenChange={open => { if (!open) setPreviewJob(null); }}>
        <DialogContent className="flex h-[100dvh] flex-col gap-3 overflow-hidden rounded-none bg-background p-4 sm:inset-0 sm:left-0 sm:top-0 sm:h-[100dvh] sm:max-h-none sm:w-screen sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-none">
          {/* pr-12 让出右上角关闭按钮的位置 */}
          <DialogHeader className="shrink-0 pr-12">
            <DialogTitle className="text-sm">视频预览</DialogTitle>
            <DialogDescription className="line-clamp-2 text-xs">
              {previewJob?.prompt}
            </DialogDescription>
          </DialogHeader>
          {previewJob && primaryAsset(previewJob)?.url && (() => {
            // 所有已完成的可预览视频
            const previewableJobs = jobs.filter(j => j.status === 'completed' && primaryAsset(j)?.url);
            const currentJob = previewableJobs[previewIndex] ?? previewJob;
            const leftVideo = primaryAsset(currentJob)?.url!;
            const rightVideo = previewMode === 'split' && splitIndex !== null
              ? primaryAsset(previewableJobs[splitIndex] ?? previewJob)?.url
              : null;
            return (
              <>
                {/* 视频区域 */}
                <div className="flex min-h-0 flex-1 items-stretch justify-center gap-2 overflow-hidden rounded-xl border border-border/60 bg-black">
                  {/* 左侧视频（主视频） */}
                  <div className="relative flex min-w-0 flex-1 items-center justify-center">
                    <video
                      key={`left-${leftVideo}`}
                      src={leftVideo}
                      poster={primaryAsset(currentJob)?.posterUrl}
                      controls={previewMode === 'single'}
                      autoPlay
                      loop
                      muted={previewMode === 'split'}
                      playsInline
                      className="max-h-full max-w-full object-contain"
                    />
                    {previewMode === 'split' && (
                      <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] text-white/80">左</span>
                    )}
                  </div>
                  {/* 右侧视频（分屏模式） */}
                  {previewMode === 'split' && rightVideo && (
                    <div className="relative flex min-w-0 flex-1 items-center justify-center border-l border-white/10">
                      <video
                        key={`right-${rightVideo}`}
                        src={rightVideo}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="max-h-full max-w-full object-contain"
                      />
                      <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] text-white/80">右</span>
                    </div>
                  )}
                  {/* 分屏模式下若未选右侧视频，显示占位 */}
                  {previewMode === 'split' && !rightVideo && (
                    <div className="flex min-w-0 flex-1 items-center justify-center border-l border-white/10">
                      <span className="text-sm text-white/40">请在下方选择右侧视频</span>
                    </div>
                  )}
                </div>

                {/* 导航栏：左右切换 + 模式切换 */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* 左右切换 */}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={previewIndex === 0 && previewableJobs.length > 0}
                      onClick={() => {
                        const prevIdx = (previewIndex - 1 + previewableJobs.length) % previewableJobs.length;
                        setPreviewIndex(prevIdx);
                        setPreviewJob(previewableJobs[prevIdx]);
                      }}
                      className="h-8 rounded-xl px-2 text-xs"
                      title="上一个视频"
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <span className="px-2 text-xs text-muted-foreground tabular-nums">
                      {previewIndex + 1} / {Math.max(1, previewableJobs.length)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={previewableJobs.length <= 1}
                      onClick={() => {
                        const nextIdx = (previewIndex + 1) % previewableJobs.length;
                        setPreviewIndex(nextIdx);
                        setPreviewJob(previewableJobs[nextIdx]);
                      }}
                      className="h-8 rounded-xl px-2 text-xs"
                      title="下一个视频"
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>

                  {/* 模式切换：单屏 / 分屏 */}
                  <div className="flex items-center rounded-lg border border-border bg-muted/60 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setPreviewMode('single')}
                      className={cn(
                        'rounded-md px-2.5 py-1 font-medium transition-colors',
                        previewMode === 'single' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      单屏
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewMode('split')}
                      className={cn(
                        'rounded-md px-2.5 py-1 font-medium transition-colors',
                        previewMode === 'split' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                      title="分屏同时播放（两个视频均静音）"
                    >
                      <VolumeX className="mr-1 inline size-3" />
                      分屏
                    </button>
                  </div>
                </div>

                {/* 分屏模式下选择右侧视频 */}
                {previewMode === 'split' && previewableJobs.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">右侧视频：</span>
                    {previewableJobs.map((j, idx) => (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() => setSplitIndex(idx)}
                        className={cn(
                          'rounded-md border px-2 py-1 text-[11px] transition-colors',
                          splitIndex === idx
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {idx + 1}
                      </button>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
          <DialogFooter className="shrink-0 gap-2 sm:gap-0">
            {/* 下载 / 复制链接 / 跳转合并为菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-input bg-background px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <MoreHorizontal className="size-3.5" />
                操作
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => previewJob && void handleDownload(previewJob)}>
                  <Download className="mr-1.5 size-3.5" />
                  下载视频
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => previewJob && primaryAsset(previewJob)?.url && handleCopy(primaryAsset(previewJob)!.url, setCopiedId, previewJob.id, '链接')}>
                  {copiedId === previewJob?.id
                    ? <Check className="mr-1.5 size-3.5 text-emerald-600" />
                    : <Copy className="mr-1.5 size-3.5" />}
                  复制链接
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => previewJob && primaryAsset(previewJob)?.url && window.open(primaryAsset(previewJob)!.url, '_blank')}>
                  <ExternalLink className="mr-1.5 size-3.5" />
                  新窗口打开
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 链接失效确认。默认不删——用户可能还想复制提示词或重用参数 */}
      <Dialog open={Boolean(expiredJob)} onOpenChange={open => { if (!open) setExpiredJob(null); }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>该视频链接已失效</DialogTitle>
            <DialogDescription className="text-xs">
              上游生成的视频通常仅保留数小时，这条记录的视频已经无法访问。是否删除这条记录？
              保留的话仍可复制提示词或重用参数。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setExpiredJob(null)} className="rounded-xl">
              保留记录
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (expiredJob) removePluginJob(expiredJob.id);
                setExpiredJob(null);
                showToast?.('已删除失效记录', 'info');
              }}
              className="rounded-xl"
            >
              删除记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清空确认 */}
      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>清空所有视频记录？</DialogTitle>
            <DialogDescription className="text-xs">
              此操作将清除浏览器本地保存的所有任务与链接，已生成的视频如果未下载将无法从历史中找回。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setClearDialogOpen(false)} className="rounded-xl">
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                clearPluginJobs();
                setClearDialogOpen(false);
                showToast?.('历史已清空', 'info');
              }}
              className="rounded-xl"
            >
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
interface JobCardProps {
  job: PluginJob;
  copiedId: string | null;
  copiedPromptId: string | null;
  downloadingId: string | null;
  probingId: string | null;
  onCopyLink: (url: string) => void;
  onCopyPrompt: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onReuseParams?: (job: PluginJob) => void;
  onRemove: () => void;
}

/**
 * 一条历史记录。参数用提交时冻结的 paramSummary 渲染，因此插件卸载后
 * 卡片依然显示「原版 · 1080P · 9:16 · 8秒」而不是一串裸键值。
 */
function JobCard({
  job,
  copiedId,
  copiedPromptId,
  downloadingId,
  probingId,
  onCopyLink,
  onCopyPrompt,
  onPreview,
  onDownload,
  onReuseParams,
  onRemove,
}: JobCardProps) {
  const isProcessing = isActivePluginJob(job);
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';
  const asset = primaryAsset(job);
  const statusLabel = job.status === 'uploading'
    ? '上传素材中'
    : job.status === 'queued' || job.status === '排队中'
      ? '本机排队中'
      : job.upstreamStatus === 'queued'
        ? '上游排队中'
        : '生成中...';

  return (
    <div className="group relative flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3.5 transition-colors hover:border-border">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {isProcessing && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
              <Loader2 className="size-3.5 animate-spin" />
              {statusLabel}
            </span>
          )}
          {isCompleted && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              <Check className="size-3.5" />
              已完成
            </span>
          )}
          {isFailed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold text-destructive">
              <XCircle className="size-3.5" />
              生成失败
            </span>
          )}

          <span className="text-xs font-medium text-foreground">{job.modelLabel}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {job.pluginName}
          </span>
          {/* 并发子任务标记 */}
          {job.parallelCount && job.parallelCount > 1 && (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              并发 x{job.parallelCount}
              {job.subTasks && (() => {
                const done = job.subTasks.filter(st => st.status === 'completed').length;
                const failed = job.subTasks.filter(st => st.status === 'failed').length;
                return ` (${done}成${failed > 0 ? `/${failed}败` : ''}/${job.subTasks.length})`;
              })()}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {job.paramSummary.slice(1).map((chip, index) => (
            <span key={index} className="rounded-md bg-muted px-1.5 py-0.5" title={chip.label}>
              {chip.value}
            </span>
          ))}
          {job.estimatedCost !== null && job.estimatedCost > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-primary">
              {CURRENCY_SYMBOL[job.currency] || ''}{job.estimatedCost.toFixed(2)}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground/80">
            {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {/* 上传 / 生成用时：进行中每秒跳动，完成后保留 */}
          <PluginJobTimings job={job} live={isProcessing} />
        </div>
      </div>

      {job.prompt && (
        <div className="relative rounded-xl border border-border/40 bg-card/60 p-3 text-xs leading-relaxed text-foreground">
          <p className="line-clamp-3 select-text pr-14">{job.prompt}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopyPrompt}
            className="absolute right-2 top-2 h-7 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-foreground"
            title="复制提示词"
          >
            {copiedPromptId === job.id ? (
              <>
                <Check className="mr-1 size-3 text-emerald-600" />
                已复制
              </>
            ) : (
              <>
                <Copy className="mr-1 size-3" />
                复制
              </>
            )}
          </Button>
        </div>
      )}

      {/* 进行中：上传素材 + 生成轮询的分段进度 */}
      {isProcessing && <PluginJobProgressPanel job={job} />}

      {isFailed && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1">
            <strong>错误信息：</strong> {job.error || '生成失败，可能是提示词触发合规过滤或服务繁忙'}
          </div>
          {/* 文件还在内存里才给重试；刷新过页面就没得重试了 */}
          {canRetry(job.id) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => retryPluginJob(job.id)}
              className="h-7 shrink-0 rounded-lg px-2 text-[11px]"
            >
              <RotateCw className="mr-1 size-3" />
              重试上传
            </Button>
          )}
        </div>
      )}

      {/* 已完成：改为点击预览，避免列表一渲染就把每条视频都拉一遍 */}
      {isCompleted && asset?.url ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2">
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={onPreview}
              disabled={probingId === job.id}
              className="h-8 rounded-xl px-3 text-xs font-semibold shadow-sm"
            >
              {probingId === job.id
                ? <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                : <Play className="mr-1.5 size-3.5" />}
              预览
            </Button>

            {/* 下载 / 复制链接 / 跳转合并为菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={probingId === job.id}
                className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-input bg-background px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <MoreHorizontal className="size-3.5" />
                操作
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={onDownload}>
                  <Download className="mr-1.5 size-3.5" />
                  下载视频
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCopyLink(asset.url)}>
                  {copiedId === job.id
                    ? <Check className="mr-1.5 size-3.5 text-emerald-600" />
                    : <Copy className="mr-1.5 size-3.5" />}
                  复制链接
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.open(asset.url, '_blank')}>
                  <ExternalLink className="mr-1.5 size-3.5" />
                  新窗口打开
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <JobCardActions job={job} onReuseParams={onReuseParams} onRemove={onRemove} />
        </div>
      ) : (
        <div className="flex items-center justify-end gap-1.5 border-t border-border/40 pt-1">
          <JobCardActions job={job} onReuseParams={onReuseParams} onRemove={onRemove} />
        </div>
      )}
    </div>
  );
}

/** 重用参数 + 删除。完成态与未完成态共用，避免两处写同一对按钮。 */
function JobCardActions({
  job,
  onReuseParams,
  onRemove,
}: {
  job: PluginJob;
  onReuseParams?: (job: PluginJob) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {onReuseParams && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReuseParams(job)}
          className="h-8 rounded-xl px-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="mr-1 size-3" />
          重用参数
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="h-8 rounded-xl px-2.5 text-xs text-muted-foreground hover:text-destructive"
        title="删除此记录"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
