'use client';

import {
  ArrowUp,
  CloudUpload,
  Info,
  Link,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { normalizeNativeGifParams } from '@/lib/native-gif';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AttachmentChips } from '@/components/AttachmentChips';
import { GptImageAdvancedParamsControl } from '@/components/GptImageAdvancedParamsControl';
import { cn } from '@/lib/utils';
import {
  GIF_MAX_REF_IMAGES,
  type GifModel,
} from '@/lib/gif-job-store';
import type { RefImageData } from '@/lib/job-store';
import { supportsNativeImageOutput, supportsGptImageAdvancedParams, type GptImageAdvancedParams } from '@/lib/model-capabilities';

export interface GifUploadedRef extends RefImageData {
  preview: string;
  badge?: string;
}

export interface GifParametersPanelProps {
  nativeGif: boolean;
  gifFrameCount: number;
  onGifFrameCountChange: (value: number) => void;
  gifFrameDurationMs: number;
  onGifFrameDurationMsChange: (value: number) => void;
  onNativeGifChange: (value: boolean) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  model: GifModel;
  modelOptions: { value: GifModel; label: string }[];
  modelPopoverOpen: boolean;
  onModelPopoverOpenChange: (open: boolean) => void;
  onModelChange: (value: GifModel) => void;
  gptImageAdvancedParams: GptImageAdvancedParams;
  onGptImageAdvancedParamsChange: (value: GptImageAdvancedParams) => void;
  closedLoop: boolean;
  onClosedLoopToggle: (value: boolean) => void;
  refFiles: GifUploadedRef[];
  onRemoveRef: (id: string) => void;
  maxedOut: boolean;
  isDragOver: boolean;
  uploading: boolean;
  uploadError: string | null;
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  disabled: boolean;
  generating: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onConfigureApiKey: () => void;
  onOptimize: () => void;
  onClear: () => void;
}

function formatModelLabel(model: GifModel, modelOptions: { value: GifModel; label: string }[]): string {
  return modelOptions.find(option => option.value === model)?.label || model;
}

export function GifParametersPanel(props: GifParametersPanelProps) {
  if (props.disabled) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-muted/40 px-4 py-8 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Info className="h-5 w-5" />
        </div>
        <div className="max-w-md">
          <p className="text-base font-medium text-foreground">需要先配置令牌</p>
          <p className="mt-2 text-sm text-muted-foreground">
            请先在设置中配置 Nova API 密钥，才能使用动图生成功能。
          </p>
        </div>
        <Button onClick={props.onConfigureApiKey}>配置</Button>
      </div>
    );
  }

  if (props.modelOptions.length === 0) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-muted/40 px-4 py-8 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Info className="h-5 w-5" />
        </div>
        <div className="max-w-md">
          <p className="text-base font-medium text-foreground">没有可用的 GIF 模型</p>
          <p className="mt-2 text-sm text-muted-foreground">
            请先在设置中完成至少一个 image 系列的 4K 图片模型配置。banana 系列不支持这里需要的自定义分辨率，所以不会显示。
          </p>
        </div>
        <Button onClick={props.onConfigureApiKey}>打开设置</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-xl border border-border bg-muted/50 shadow-md md:h-[calc(100vh-400px)]">
      <div className="min-h-0 md:flex-1 md:overflow-y-auto">
        {props.nativeGif ? <p className="p-4 text-sm text-muted-foreground">原生 GIF 仅支持文字生成，不使用参考图。</p> : <div className="p-4">
          <div
            onDrop={props.onDrop}
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            className={cn(
              'relative overflow-hidden rounded-xl border-2 border-dashed px-6 py-8 text-center transition-all',
              props.maxedOut
                ? 'cursor-not-allowed border-border bg-muted/40 text-muted-foreground'
                : props.isDragOver
                  ? 'border-primary bg-primary/20'
                  : 'cursor-pointer border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10',
            )}
          >
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={props.uploading || props.maxedOut}
              onChange={props.onFileSelect}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              style={{ fontSize: 0 }}
            />
            <CloudUpload className={cn('mx-auto mb-1 h-6 w-6', props.isDragOver ? 'text-primary' : 'text-muted-foreground')} />
            <p className="text-sm font-medium">
              {props.uploading
                ? '读取中...'
                : props.maxedOut
                  ? `已达到 ${GIF_MAX_REF_IMAGES} 张参考图上限`
                  : props.isDragOver
                    ? '将参考图拖放到这里'
                    : '可选：拖放或粘贴参考图'}
            </p>
            <p className="text-xs text-muted-foreground">最多 {GIF_MAX_REF_IMAGES} 张 · 当前 {props.refFiles.length} 张</p>
          </div>
        </div>}

        {!props.nativeGif && props.refFiles.length > 0 && (
          <div className="px-4 pb-2">
            <AttachmentChips
              files={props.refFiles}
              onRemove={props.onRemoveRef}
              sourceKind="gif"
              sourceLabel="GIF 参考图"
              prompt={props.prompt}
            />
          </div>
        )}

        <Textarea
          value={props.prompt}
          onChange={event => props.onPromptChange(event.target.value)}
          placeholder="描述动画主题 / 动作，例如：一只虎斑猫缓慢眨眼"
          rows={3}
          className="resize-none rounded-none border-0 bg-transparent placeholder:text-placeholder focus-visible:border-0 focus-visible:ring-0"
        />

        {!props.nativeGif && props.uploadError && (
          <div className="px-4 pb-3">
            <p className="text-sm text-destructive">{props.uploadError}</p>
          </div>
        )}
      </div>

      <div className="flex-none border-t border-border/50 px-4 py-3">
        <div role="group" aria-label="动图工具栏" className="flex flex-wrap items-center gap-1.5">
          <Popover open={props.modelPopoverOpen} onOpenChange={props.onModelPopoverOpenChange}>
            <PopoverTrigger
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="模型"
            >
              <Sparkles className="h-3 w-3" />
              <span className="shrink-0 truncate text-[11px]">{formatModelLabel(props.model, props.modelOptions)}</span>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {props.modelOptions.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    props.onModelChange(option.value);
                    props.onModelPopoverOpenChange(false);
                  }}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 rounded-md text-sm hover:bg-muted',
                    props.model === option.value && 'bg-muted font-medium',
                  )}
                >
                  {option.label}
                </button>
              ))}
              <p className="px-2.5 py-1 text-[11px] text-muted-foreground">支持 2.6 原生 GIF，或支持自定义网格分辨率的 image 模型</p>
            </PopoverContent>
          </Popover>

          {supportsGptImageAdvancedParams(props.model) && (
            <GptImageAdvancedParamsControl
              model={props.model}
              value={props.gptImageAdvancedParams}
              onChange={props.onGptImageAdvancedParamsChange}
              variant="outline"
              size="xs"
            />
          )}

          {supportsNativeImageOutput(props.model) && (
            <label className="flex h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap px-1 text-[11px] text-foreground">
              <Switch size="sm" variant="neutral" checked={props.nativeGif} onCheckedChange={props.onNativeGifChange} disabled={props.generating} aria-label="原生 GIF 模式" />
              原生 GIF
            </label>
          )}

          {props.nativeGif && (
            <div role="group" aria-label="原生 GIF 参数" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                帧数
                <Input type="number" min={1} step={1} aria-label="GIF 帧数"
                  value={Number.isFinite(props.gifFrameCount) ? props.gifFrameCount : ''}
                  onChange={event => props.onGifFrameCountChange(event.target.valueAsNumber)}
                  onBlur={() => props.onGifFrameCountChange(normalizeNativeGifParams(props.gifFrameCount, props.gifFrameDurationMs).gifFrameCount)}
                  disabled={props.generating} className="h-6 w-16 rounded-md px-1.5 py-0 text-xs text-foreground md:text-xs" />
              </label>
              <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                每帧时长
                <Input type="number" min={1} step={1} aria-label="GIF 每帧时长（毫秒）"
                  value={Number.isFinite(props.gifFrameDurationMs) ? props.gifFrameDurationMs : ''}
                  onChange={event => props.onGifFrameDurationMsChange(event.target.valueAsNumber)}
                  onBlur={() => props.onGifFrameDurationMsChange(normalizeNativeGifParams(props.gifFrameCount, props.gifFrameDurationMs).gifFrameDurationMs)}
                  disabled={props.generating} className="h-6 w-20 rounded-md px-1.5 py-0 text-xs text-foreground md:text-xs" />
                毫秒
              </label>
            </div>
          )}

          <button
            type="button"
            onClick={() => props.onClosedLoopToggle(!props.closedLoop)}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'xs' }),
              'gap-1',
              props.closedLoop ? 'border-primary text-primary' : '',
            )}
            title={props.nativeGif ? '首尾动作无缝衔接' : '首尾闭合：第12帧无缝衔接回第1帧'}
          >
            <Link className="h-3 w-3" />
            <span className="text-[11px]">首尾帧闭合</span>
          </button>

          <div className="ml-auto flex justify-end gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onOptimize}
              disabled={!props.canSubmit}
              title="优化提示词"
            >
              <Sparkles className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={props.onClear}
              disabled={!props.prompt.trim() && props.refFiles.length === 0}
              title="清空提示词和图片"
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={props.onSubmit}
              disabled={!props.canSubmit}
              className="gap-1"
            >
              {props.generating
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <ArrowUp className="h-4 w-4" />}
              <span>{props.nativeGif ? '生成原生 GIF' : '生成网格图'}</span>
            </Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          2.6 模型支持原生 GIF 模式；网格模式需支持 3264×2448 自定义分辨率。
        </p>
      </div>
    </div>
  );
}
