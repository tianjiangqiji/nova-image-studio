'use client';

import { Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InstalledPlugin } from '@/lib/plugin-schema';

/**
 * 装了多个视频插件时的切换器。只装了一个时不显示——那种情况下这排按钮
 * 只是白占一行高度。
 */
export function PluginPicker({
  plugins,
  activeId,
  onSelect,
  className,
}: {
  plugins: InstalledPlugin[];
  activeId: string;
  onSelect: (id: string) => void;
  /** 紧凑场景（如画布编排节点）可覆盖底部分隔线与间距 */
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 border-b border-border/50 pb-3', className)}>
      <span className="mr-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Package className="size-3" />
        插件
      </span>
      {plugins.map(plugin => (
        <button
          key={plugin.id}
          type="button"
          onClick={() => onSelect(plugin.id)}
          title={`${plugin.name} v${plugin.version}${plugin.description ? ` · ${plugin.description}` : ''}`}
          className={cn(
            'rounded-xl border px-2.5 py-1 text-[11px] transition-all duration-150 active:scale-95',
            plugin.id === activeId
              ? 'border-primary/60 bg-primary/10 font-medium text-foreground'
              : 'border-border bg-card text-muted-foreground hover:text-foreground',
          )}
        >
          {plugin.name}
        </button>
      ))}
    </div>
  );
}
