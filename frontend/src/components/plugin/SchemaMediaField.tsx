'use client';

import { useRef } from 'react';
import { Film, Image as ImageIcon, Loader2, Mic, Music, Plus, Upload, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MediaLimitsPopover } from '@/components/plugin/MediaLimitsPopover';
import { useMediaDropZone } from '@/hooks/useMediaDropZone';
import { formatBytes, getAcceptAttribute } from '@/lib/plugin-media-config';
import type { MediaKind, PluginField } from '@/lib/plugin-schema';
import type { PendingMedia } from '@/lib/plugin-upload-runner';

const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  images: ImageIcon,
  videos: Video,
  audios: Music,
};

const CHIP_ICON: Record<MediaKind, typeof ImageIcon> = {
  images: ImageIcon,
  videos: Film,
  audios: Mic,
};

/** schema 里的 accent 名 → 配色。认不出来的回落到主色。 */
const ACCENT_TEXT: Record<string, string> = {
  blue: 'text-blue-500',
  emerald: 'text-emerald-500',
  amber: 'text-amber-500',
  primary: 'text-primary',
};

interface SchemaMediaFieldProps {
  field: PluginField;
  maxCount: number;
  required: boolean;
  items: PendingMedia[];
  busy: boolean;
  onPick: (files: File[]) => void;
  onRemove: (index: number) => void;
}

/**
 * 一个素材槽。三种呈现由 schema 的 `style` 决定：
 *   frame     首尾帧这类「一格一张」的宽画幅缩略图
 *   thumbnail 参考图这类方形缩略图网格
 *   chip      视频/音频这类只展示文件名 + 体积的胶囊
 *
 * 之所以不做成通用的「一种呈现打天下」：视频文件没有可显示的缩略图，
 * 而首帧和参考图的画幅期望本来就不同，硬统一反而更难看。
 */
export function SchemaMediaField({
  field,
  maxCount,
  required,
  items,
  busy,
  onPick,
  onRemove,
}: SchemaMediaFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const kind = (field.kind || 'images') as MediaKind;
  const drop = useMediaDropZone(onPick, busy);
  const accent = ACCENT_TEXT[field.accent || 'primary'] || 'text-primary';
  const Icon = KIND_ICON[kind];
  const ChipIcon = CHIP_ICON[kind];
  const label = field.label || field.key;
  const hint = required && field.requiredHint ? field.requiredHint : field.hint;
  const style = field.style || 'thumbnail';

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={getAcceptAttribute(kind)}
      multiple={maxCount > 1}
      className="hidden"
      onChange={event => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) onPick(files);
        event.target.value = '';
      }}
    />
  );

  const header = (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Icon className={cn('size-3.5', accent)} />
        {label} ({items.length}/{maxCount})
        {required && <span className="text-destructive">*必填</span>}
        {field.hint && style === 'frame' && (
          <span className="text-[11px] font-normal text-muted-foreground">{field.hint}</span>
        )}
        <MediaLimitsPopover kind={kind} />
      </span>
      {items.length < maxCount && style !== 'frame' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={cn('h-6 px-2 text-[11px]', accent)}
        >
          {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Plus className="mr-1 size-3" />}
          添加
        </Button>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        'space-y-1.5 rounded-xl border border-dashed p-2 transition-colors',
        drop.isDragOver ? 'border-primary bg-primary/10' : 'border-transparent',
      )}
      {...drop.dropProps}
    >
      {header}
      {fileInput}

      {style === 'chip' ? (
        <div className="flex flex-wrap gap-2">
          {/* 显示真实文件名与体积，提交前用户能核对选的是不是那一份 */}
          {items.map((item, index) => (
            <div
              key={item.id}
              className="group relative flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-muted px-2.5 py-1 text-xs"
              title={item.file.name}
            >
              <ChipIcon className={cn('size-3', accent)} />
              <span className="max-w-[9rem] truncate font-mono text-[11px]">{item.file.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(item.file.size)}</span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="ml-1 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"
                aria-label={`移除 ${item.file.name}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {items.length === 0 && (
            <div className="text-[11px] text-muted-foreground">未添加{label}（可选，可拖入）</div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item, index) => (
            <div
              key={item.id}
              className={cn(
                'group relative overflow-hidden rounded-xl border border-border bg-black',
                style === 'frame' ? 'aspect-video w-24' : 'size-16',
              )}
            >
              {/* 本地 objectURL 预览，不走图片优化 */}
              <img
                src={item.previewUrl}
                alt={`${label}${index + 1}`}
                className={cn('h-full w-full', style === 'frame' ? 'object-contain' : 'object-cover')}
              />
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-md bg-black/70 text-white opacity-80 hover:opacity-100"
                aria-label={`移除${label}${index + 1}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {items.length < maxCount && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className={cn(
                'flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed transition-colors',
                style === 'frame' ? 'aspect-video w-24' : 'size-16',
                required && items.length === 0
                  ? 'border-destructive/50 bg-destructive/5 hover:border-destructive'
                  : 'border-border bg-card/60 hover:border-primary/60',
              )}
            >
              {busy
                ? <Loader2 className="size-4 animate-spin text-primary" />
                : <Upload className="size-4 text-muted-foreground" />}
              <span className="text-[10px] text-muted-foreground">
                {items.length === 0 ? '选择' : '再加一个'}
              </span>
            </button>
          )}
        </div>
      )}

      {hint && style !== 'frame' && (
        <p className={cn('text-[11px] leading-relaxed', required ? 'text-destructive/90' : 'text-muted-foreground')}>
          {hint}
        </p>
      )}
    </div>
  );
}
