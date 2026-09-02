'use client';

import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatBytes, getMediaConfig } from '@/lib/plugin-media-config';
import type { MediaKind } from '@/lib/plugin-schema';

interface MediaLimitsPopoverProps {
  kind: MediaKind;
  className?: string;
}

/**
 * 素材格式/体积说明。用小按钮承载详情而不是把三类限制全写进正文——
 * 参考区本来就挤，铺开写会很乱。
 */
export function MediaLimitsPopover({ kind, className }: MediaLimitsPopoverProps) {
  const config = getMediaConfig(kind);

  return (
    <Popover>
      <PopoverTrigger
        title={`查看支持的${config.label}格式与体积上限`}
        aria-label={`支持的${config.label}格式`}
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70',
          'transition-colors hover:bg-muted hover:text-foreground',
          className,
        )}
      >
        <Info className="size-3" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="space-y-2 text-[11px] leading-relaxed">
          <p className="text-xs font-medium text-foreground">支持的{config.label}格式</p>
          <div className="flex flex-wrap gap-1">
            {config.extensions.map(ext => (
              <span key={ext} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                .{ext}
              </span>
            ))}
          </div>
          <p className="text-muted-foreground">
            单个体积上限 <span className="font-medium text-foreground">{formatBytes(config.maxBytes)}</span>
          </p>
          <p className="text-muted-foreground/80">
            {config.compress
              ? '图片会在浏览器内自动重编码为 WebP 后再上传；超限时会逐步降低分辨率，仍超限才会报错。'
              : `${config.label}不做压缩，超过上限请先自行压缩。`}
          </p>
          <p className="text-muted-foreground/80">支持点击选择或直接拖拽文件到此区域，可一次选多个。</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
