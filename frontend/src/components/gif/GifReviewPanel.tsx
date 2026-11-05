'use client';

import { useState } from 'react';
import { NativeGifResultPanel } from './NativeGifResultPanel';
import {
  AlertCircle,
  Crop,
  Download,
  Film,
  Loader2,
  Maximize2,
  RefreshCw,
  Repeat,
  Repeat1,
  RotateCcw,
  Thermometer,
  Timer,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ImageHoverActions } from '@/components/workspace/results/ImageHoverActions';
import { cn } from '@/lib/utils';
import { GIF_MAX_FRAME_PADDING, type ActiveGifJob, type GifStatus } from '@/lib/gif-job-store';
import type { ImageActionPayload } from '@/lib/image-actions';

export interface GifReviewPanelProps {
  nativeGif?: boolean;
  status: GifStatus;
  job: ActiveGifJob | null;
  gridImageUrl: string | null;
  gifBlob: Blob | null;
  elapsedSeconds: number;
  gifReady: boolean;
  loop: boolean;
  onLoopToggle: (value: boolean) => void;
  frameDelayMs: number;
  onFrameDelayChange: (value: number) => void;
  loopCount: number;
  onLoopCountChange: (value: number) => void;
  framePadding: number;
  onFramePaddingChange: (value: number) => void;
  onOpenPreview: () => void;
  onEncodeGif: () => void;
  onDownloadAgain: () => void;
  onRetryRegenerate: () => void;
  onReset: () => void;
  onRefreshFromServer: () => void;
  isSyncing: boolean;
  refreshCooldownActive: boolean;
  onBackToReview: () => void;
  gridActionPayload?: ImageActionPayload;
}

export function GifReviewPanel(props: GifReviewPanelProps) {
  const [delayPopoverOpen, setDelayPopoverOpen] = useState(false);
  const [loopPopoverOpen, setLoopPopoverOpen] = useState(false);
  const [paddingPopoverOpen, setPaddingPopoverOpen] = useState(false);

  if (props.job ? props.job.nativeGif : props.nativeGif) return <NativeGifResultPanel {...props} />;

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-md">
      <header className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <Film className="h-4 w-4 text-primary" />
        审查与导出
      </header>

      {props.status === 'idle' && (
        <div className="flex min-h-64 flex-col items-center justify-center text-center text-sm text-muted-foreground">
          <p>填写参数后，点击「生成网格图」开始。</p>
          <p className="mt-1 text-xs">生成完成后请审查 12 帧网格再合成 GIF。</p>
        </div>
      )}

      {props.status === 'generating_grid' && (
        <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p>正在生成网格图，已用 <span className="font-mono text-foreground">{props.elapsedSeconds}</span> 秒…</p>
          {props.job?.serverTaskId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={props.onRefreshFromServer}
              disabled={props.isSyncing || props.refreshCooldownActive}
              className="gap-1"
            >
              {props.isSyncing
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="h-3.5 w-3.5" />}
              主动同步状态
            </Button>
          )}
        </div>
      )}

      {(props.status === 'review_grid' || props.status === 'generating_gif' || props.status === 'done') && props.gridImageUrl && (
        <div className="space-y-3">
          <div className="group relative overflow-hidden rounded-lg bg-muted">
            <button
              type="button"
              onClick={props.onOpenPreview}
              className="block w-full"
            >
              <img
                src={props.gridImageUrl}
                alt="GIF 网格底图"
                className="block w-full"
                draggable={false}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
                <Maximize2 className="h-6 w-6 text-white opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </button>
            {props.gridActionPayload && (
              <ImageHoverActions
                payload={props.gridActionPayload}
                onPreview={props.onOpenPreview}
              />
            )}
          </div>

          {(props.status === 'review_grid' || props.status === 'done') && (
            <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">GIF 参数</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => props.onLoopToggle(!props.loop)}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'xs' }),
                    'gap-1',
                    props.loop ? 'text-primary' : 'text-muted-foreground',
                  )}
                  title="循环模式"
                >
                  {props.loop ? <Repeat className="h-3.5 w-3.5" /> : <Repeat1 className="h-3.5 w-3.5" />}
                  <span className="font-medium">{props.loop ? '循环' : '不循环'}</span>
                </button>

                <Popover open={delayPopoverOpen} onOpenChange={setDelayPopoverOpen}>
                  <PopoverTrigger
                    className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'gap-1 text-muted-foreground')}
                    title="帧间隔"
                  >
                    <Timer className="h-3.5 w-3.5" />
                    <span className="font-medium">{props.frameDelayMs}ms</span>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium">帧间隔</label>
                        <span className="text-sm text-muted-foreground">{props.frameDelayMs} ms</span>
                      </div>
                      <Slider
                        value={[props.frameDelayMs]}
                        onValueChange={value => props.onFrameDelayChange(value[0])}
                        min={50}
                        max={1000}
                        step={10}
                      />
                      <p className="text-[11px] text-muted-foreground">12 帧 × {props.frameDelayMs}ms ≈ {(12 * props.frameDelayMs / 1000).toFixed(2)} 秒一个循环</p>
                    </div>
                  </PopoverContent>
                </Popover>

                {props.loop && (
                  <Popover open={loopPopoverOpen} onOpenChange={setLoopPopoverOpen}>
                    <PopoverTrigger
                      className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'gap-1 text-muted-foreground')}
                      title="循环次数（0 = 无限）"
                    >
                      <Thermometer className="h-3.5 w-3.5" />
                      <span className="font-medium">{props.loopCount === 0 ? '∞' : `x${props.loopCount}`}</span>
                    </PopoverTrigger>
                    <PopoverContent className="w-56">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">循环次数</label>
                        <Input
                          type="number"
                          min={0}
                          max={999}
                          value={props.loopCount}
                          onChange={event => {
                            const v = Number(event.target.value);
                            props.onLoopCountChange(Number.isFinite(v) && v >= 0 ? Math.min(999, Math.floor(v)) : 0);
                          }}
                        />
                        <p className="text-[11px] text-muted-foreground">0 = 无限循环；正整数 = 仅播放 N 次。</p>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}

                <Popover open={paddingPopoverOpen} onOpenChange={setPaddingPopoverOpen}>
                  <PopoverTrigger
                    className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'gap-1 text-muted-foreground')}
                    title="边距裁切：去除网格分隔条造成的黑边"
                  >
                    <Crop className="h-3.5 w-3.5" />
                    <span className="font-medium">{props.framePadding.toFixed(1)}%</span>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium">边距裁切</label>
                        <span className="text-sm text-muted-foreground">{props.framePadding.toFixed(1)} %</span>
                      </div>
                      <Slider
                        value={[props.framePadding]}
                        onValueChange={value => props.onFramePaddingChange(value[0])}
                        min={0}
                        max={GIF_MAX_FRAME_PADDING}
                        step={0.1}
                      />
                      <p className="text-[11px] text-muted-foreground">在自动检测黑边的基础上，每帧四边再额外内缩 {props.framePadding.toFixed(1)}%。设为 0 时仅依赖自动检测。</p>
                    </div>
                  </PopoverContent>
                </Popover>

                <button
                  type="button"
                  onClick={() => {
                    props.onLoopToggle(true);
                    props.onFrameDelayChange(120);
                    props.onLoopCountChange(0);
                    props.onFramePaddingChange(2.0);
                  }}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'gap-1 text-muted-foreground')}
                  title="重置 GIF 参数为默认值"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="font-medium">重置</span>
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {props.status === 'review_grid' && (
              <Button onClick={props.onEncodeGif} className="gap-1">
                <Film className="h-4 w-4" />
                生成 GIF
              </Button>
            )}
            {props.status === 'generating_gif' && (
              <Button disabled className="gap-1">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在合成 GIF…
              </Button>
            )}
            {props.status === 'done' && props.gifBlob && (
              <>
                <Button onClick={props.onDownloadAgain} className="gap-1">
                  <Download className="h-4 w-4" />
                  再次下载 GIF
                </Button>
                <Button variant="outline" onClick={props.onBackToReview} className="gap-1">
                  <RotateCcw className="h-4 w-4" />
                  重新生成 GIF
                </Button>
              </>
            )}
            {props.status === 'done' && !props.gifBlob && (
              <Button onClick={props.onBackToReview} className="gap-1">
                <Film className="h-4 w-4" />
                重新生成 GIF
              </Button>
            )}
            <Button variant="outline" onClick={props.onRetryRegenerate} className="gap-1" disabled={props.status === 'generating_gif'}>
              <RotateCcw className="h-4 w-4" />
              重新生成网格图
            </Button>
            <Button variant="ghost" onClick={props.onReset} className="gap-1" disabled={props.status === 'generating_gif'}>
              <X className="h-4 w-4" />
              清空
            </Button>
          </div>
        </div>
      )}

      {props.status === 'failed' && (
        <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">任务失败</p>
              <p className="mt-1 text-xs">{props.job?.error || '未知错误'}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={props.onRetryRegenerate} className="gap-1">
              <RotateCcw className="h-4 w-4" />
              重试
            </Button>
            <Button variant="ghost" onClick={props.onReset} className="gap-1">
              <X className="h-4 w-4" />
              清空
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
