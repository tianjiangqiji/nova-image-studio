'use client';

import { useRef } from 'react';
import { Bot, Film, Frame, Images, LibraryBig, ScanSearch, Scissors, Sparkles, Video } from 'lucide-react';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';

interface WorkspaceModeTabsProps {
  wideMode?: boolean;
  showPromptGallery?: boolean;
}

const horizontalTriggerClass =
  'group h-full min-h-0 min-w-0 gap-1 overflow-hidden whitespace-nowrap rounded-xl px-2 py-2 text-xs max-sm:w-14 max-sm:shrink-0 max-sm:flex-none max-sm:data-active:w-auto max-sm:data-active:min-w-[88px] sm:h-[calc(100%-1px)] sm:gap-2 sm:px-3 sm:py-2 sm:text-sm';

const labelClass = 'max-sm:hidden max-sm:group-data-active:inline';

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
  const dragStateRef = useRef({
    pointerId: -1,
    startX: 0,
    scrollLeft: 0,
    dragged: false,
  });

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

  // 窄屏 → 水平标签栏
  return (
    <TabsList
      className={`scrollbar-hide flex h-16 w-full max-w-full touch-pan-x select-none justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-2xl bg-muted p-1 sm:grid ${gridCols} sm:overflow-visible sm:border sm:border-border sm:select-auto`}
      onPointerDown={event => {
        const el = event.currentTarget;
        if (!el || (event.pointerType === 'mouse' && event.button !== 0) || el.scrollWidth <= el.clientWidth) return;

        // 刻意不在这里 setPointerCapture：一旦容器捕获指针，pointerup 会被重定向到容器，
        // click 的目标随之变成 TabsList 而不是被点的 TabsTrigger，标签就再也切不动了。
        // 捕获推迟到 pointermove 里真正判定为拖动之后（见下），单纯点击全程不涉及捕获。
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
          // 越过阈值才捕获：此后指针移出容器仍能继续收到 pointermove，拖动不会中断
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
        <TabsTrigger key={value} value={value} className={horizontalTriggerClass}>
          <Icon className="size-4 shrink-0" />
          <span className={labelClass}>{label}</span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
