'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Film, Frame, Images, LibraryBig, ScanSearch, Scissors, Sparkles, Video } from 'lucide-react';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

interface WorkspaceModeTabsProps {
  wideMode?: boolean;
  showPromptGallery?: boolean;
}

const tabs = [
  { value: 'agent', icon: Bot, label: 'Agent' },
  { value: 'image-generation', icon: Sparkles, label: '生图工作台' },
  // 视频能力全部来自插件包；没装插件时这个 tab 仍在，里面给出安装引导
  { value: 'video-generation', icon: Video, label: '视频工作台' },
  { value: 'canvas', icon: Frame, label: '无限画布' },
  { value: 'image-to-slice', icon: Scissors, label: 'UI设计模式' },
  { value: 'assets', icon: Images, label: '我的素材' },
  { value: 'reverse-prompt', icon: ScanSearch, label: '反推提示词' },
  { value: 'gif', icon: Film, label: '动图生成' },
] as const;

const galleryTab = { value: 'prompt-gallery', icon: LibraryBig, label: '提示词广场' } as const;

export function WorkspaceModeTabs({ wideMode = false, showPromptGallery = false }: WorkspaceModeTabsProps) {
  const gridCols = showPromptGallery ? 'sm:grid-cols-9' : 'sm:grid-cols-8';
  const allTabs = showPromptGallery ? [...tabs, galleryTab] : tabs;
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);

  const dragStateRef = useRef({
    pointerId: -1,
    startX: 0,
    scrollLeft: 0,
    dragged: false,
  });

  const checkOverflow = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const availableWidth = container.clientWidth;
    if (availableWidth <= 0) return;

    const tabEls = Array.from(measure.querySelectorAll<HTMLElement>('[data-measure-tab]'));
    if (tabEls.length === 0) return;

    // 测量全展开状态下，各 tab 的实际像素宽度
    let maxTabWidth = 0;
    for (const el of tabEls) {
      const width = el.getBoundingClientRect().width;
      if (width > maxTabWidth) {
        maxTabWidth = width;
      }
    }

    const n = tabEls.length;
    const gap = 4; // gap-1 (4px)
    const containerPaddingAndBorder = 14; // p-1 (8px) + border (2px) + buffer (4px)
    // 在均分网格 (sm:grid-cols-8/9) 模式下，每列宽度必须至少能够容纳最长 tab 的图标与文字
    const requiredGridWidth = Math.ceil(maxTabWidth * n + gap * (n - 1) + containerPaddingAndBorder);

    let shouldCompact = availableWidth < requiredGridWidth;

    // 备用兜底检查：若当前处于非 compact 状态，但已有任何可见 label 出现截断 (scrollWidth > clientWidth)，立即切入 compact
    if (!shouldCompact) {
      const activeLabels = container.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"] .tab-label');
      for (const label of activeLabels) {
        if (label.scrollWidth > label.clientWidth + 1) {
          shouldCompact = true;
          break;
        }
      }
    }

    setIsCompact(prev => (prev !== shouldCompact ? shouldCompact : prev));
  }, []);

  useEffect(() => {
    if (wideMode) return;
    checkOverflow();

    const container = containerRef.current;
    if (!container) return;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        checkOverflow();
      });
      resizeObserver.observe(container);
    }

    const handleResize = () => checkOverflow();
    window.addEventListener('resize', handleResize);

    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts?.ready?.then?.(() => {
        checkOverflow();
      });
    }

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [checkOverflow, wideMode, showPromptGallery]);

  useEffect(() => {
    if (!isCompact || !containerRef.current) return;
    const activeEl = containerRef.current.querySelector<HTMLElement>('[data-active]');
    if (activeEl) {
      activeEl.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [isCompact]);

  if (wideMode) {
    // 宽屏 → 垂直气泡侧边栏
    return (
      <TabsList className="w-full flex-col gap-1.5 rounded-2xl border border-border bg-muted/50 p-2">
        {allTabs.map(({ value, icon: Icon, label }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="flex flex-row items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium data-active:bg-card data-active:text-foreground data-active:shadow-sm"
          >
            <Icon className="size-5 shrink-0" />
            <span>{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    );
  }

  // 手机模式/紧凑模式与标准桌面网格模式类名切换
  const listClassName = isCompact
    ? 'scrollbar-hide flex h-16 w-full max-w-full touch-pan-x select-none justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-2xl border border-border bg-muted p-1'
    : cn(
        'scrollbar-hide flex h-16 w-full max-w-full touch-pan-x select-none justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-2xl bg-muted p-1',
        'sm:grid sm:overflow-visible sm:border sm:border-border sm:select-auto',
        gridCols
      );

  const triggerClassName = isCompact
    ? 'group h-full min-h-0 min-w-0 gap-1 overflow-hidden whitespace-nowrap rounded-xl px-2 py-2 text-xs w-14 shrink-0 flex-none data-active:w-auto data-active:min-w-[88px] sm:gap-2 sm:px-3 sm:text-sm'
    : 'group h-full min-h-0 min-w-0 gap-1 overflow-hidden whitespace-nowrap rounded-xl px-2 py-2 text-xs max-sm:w-14 max-sm:shrink-0 max-sm:flex-none max-sm:data-active:w-auto max-sm:data-active:min-w-[88px] sm:h-[calc(100%-1px)] sm:gap-2 sm:px-3 sm:py-2 sm:text-sm';

  const labelClassName = isCompact
    ? 'tab-label hidden group-data-active:inline'
    : 'tab-label max-sm:hidden max-sm:group-data-active:inline';

  // 窄屏 → 水平标签栏（空间不足时自动提前进入手机紧凑模式）
  return (
    <div ref={containerRef} className="relative w-full min-w-0">
      <TabsList
        className={listClassName}
        onPointerDown={event => {
          const el = event.currentTarget;
          if (!el || (event.pointerType === 'mouse' && event.button !== 0) || el.scrollWidth <= el.clientWidth) return;

          dragStateRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            scrollLeft: el.scrollLeft,
            dragged: false,
          };
        }}
        onPointerMove={event => {
          const el = event.currentTarget;
          const state = dragStateRef.current;
          if (state.pointerId !== event.pointerId) return;

          const deltaX = event.clientX - state.startX;
          if (Math.abs(deltaX) > 4 && !state.dragged) {
            state.dragged = true;
            el.setPointerCapture(event.pointerId);
          }
          if (state.dragged) {
            el.scrollLeft = state.scrollLeft - deltaX;
            event.preventDefault();
          }
        }}
        onPointerUp={event => {
          const el = event.currentTarget;
          if (dragStateRef.current.pointerId !== event.pointerId) return;
          if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
          dragStateRef.current.pointerId = -1;
        }}
        onPointerCancel={event => {
          const el = event.currentTarget;
          if (dragStateRef.current.pointerId === event.pointerId && el.hasPointerCapture(event.pointerId)) {
            el.releasePointerCapture(event.pointerId);
          }
          dragStateRef.current.pointerId = -1;
        }}
        onClickCapture={event => {
          if (!dragStateRef.current.dragged) return;
          event.preventDefault();
          event.stopPropagation();
          dragStateRef.current.dragged = false;
        }}
      >
        {allTabs.map(({ value, icon: Icon, label }) => (
          <TabsTrigger
            key={value}
            value={value}
            title={label}
            className={triggerClassName}
            onClick={e => {
              if (isCompact) {
                e.currentTarget.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
              }
            }}
          >
            <Icon className="size-4 shrink-0" />
            <span className={labelClassName}>{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      {/* 隐藏的测量节点：用于精确测量标准全展开状态下所需的最小物理宽度 */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none absolute -top-[9999px] left-0 flex select-none gap-1 opacity-0"
        style={{ visibility: 'hidden', pointerEvents: 'none', position: 'absolute', top: -9999, left: 0 }}
      >
        {allTabs.map(({ value, icon: Icon, label }) => (
          <div
            key={value}
            data-measure-tab={value}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium whitespace-nowrap"
          >
            <Icon className="size-4 shrink-0" />
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
