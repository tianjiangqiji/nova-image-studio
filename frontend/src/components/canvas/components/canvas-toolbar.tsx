"use client";

import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, BetweenHorizontalStart, BetweenVerticalStart, CircleDot, Columns3, Film, Grid2x2, Hand, Image as ImageIcon, Info, LayoutDashboard, LibraryBig, MousePointer2, Music, Redo2, Rows3, Search, Settings2, SlidersHorizontal, Sparkles, Square, Trash2, Type, Undo2, Workflow } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { CanvasBackgroundMode } from "../lib/canvas-theme";
import type { CanvasInteractionMode } from "../types";
import type { CanvasArrangeMode } from "../utils/canvas-layout";
import { CanvasTooltip } from "./canvas-ui";

type CanvasToolbarProps = {
  selectedCount: number;
  nodeCount: number;
  selectedConfigCount: number;
  canUndo: boolean;
  canRedo: boolean;
  backgroundMode: CanvasBackgroundMode;
  showImageInfo: boolean;
  interactionMode: CanvasInteractionMode;
  showPromptGallery?: boolean;
  onAddImage: () => void;
  onAddVideo: () => void;
  onAddAudio: () => void;
  onAddText: () => void;
  onAddAnnotation: () => void;
  onAddConfig: () => void;
  onImportPromptGallery: () => void;
  onOpenTemplate: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onArrange: (mode: CanvasArrangeMode | "graph") => void;
  onGenerateSelected: () => void;
  onSearch: () => void;
  onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
  onShowImageInfoChange: (value: boolean) => void;
  onInteractionModeChange: (mode: CanvasInteractionMode) => void;
};

export function CanvasToolbar({
  selectedCount,
  nodeCount,
  selectedConfigCount,
  canUndo,
  canRedo,
  backgroundMode,
  showImageInfo,
  interactionMode,
  showPromptGallery = true,
  onAddImage,
  onAddVideo,
  onAddAudio,
  onAddText,
  onAddAnnotation,
  onAddConfig,
  onImportPromptGallery,
  onOpenTemplate,
  onUndo,
  onRedo,
  onDelete,
  onArrange,
  onGenerateSelected,
  onSearch,
  onBackgroundModeChange,
  onShowImageInfoChange,
  onInteractionModeChange,
}: CanvasToolbarProps) {
  return (
    // 定位用 -translate-x-1/2（Tailwind v4 走独立的 translate 属性），与 animate-in 的 transform 关键帧互不覆盖
    <div
      data-canvas-no-zoom
      className="absolute top-4 left-1/2 z-50 flex -translate-x-1/2 animate-in items-center gap-1 rounded-2xl border border-border bg-card/95 px-2 py-1.5 shadow-lg duration-200 fade-in-0 slide-in-from-top-2 backdrop-blur transition-shadow hover:shadow-xl"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Segmented
        value={interactionMode}
        onChange={onInteractionModeChange}
        options={[
          { value: "select", icon: <MousePointer2 />, title: "选择模式" },
          { value: "pan", icon: <Hand />, title: "抓手模式" },
        ]}
        className="border-0 bg-transparent p-0"
      />

      <div className="mx-1 h-5 w-px bg-border" />

      <CanvasTooltip label="添加图片节点">
        <Button variant="ghost" size="icon-sm" onClick={onAddImage} aria-label="添加图片节点">
          <ImageIcon className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加视频节点（可上传参考视频 / 承接视频生成结果）">
        <Button variant="ghost" size="icon-sm" onClick={onAddVideo} aria-label="添加视频节点">
          <Film className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加音频节点（上传参考音频素材）">
        <Button variant="ghost" size="icon-sm" onClick={onAddAudio} aria-label="添加音频节点">
          <Music className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加文本节点">
        <Button variant="ghost" size="icon-sm" onClick={onAddText} aria-label="添加文本节点">
          <Type className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加注释节点">
        <Button variant="ghost" size="icon-sm" onClick={onAddAnnotation} aria-label="添加注释节点">
          <Square className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加编排节点（提示词 + 参数 + 生成）">
        <Button variant="ghost" size="icon-sm" onClick={onAddConfig} aria-label="添加编排节点">
          <Settings2 className="size-4" />
        </Button>
      </CanvasTooltip>
      {showPromptGallery && (
        <CanvasTooltip label="从提示词广场导入">
          <Button variant="ghost" size="icon-sm" onClick={onImportPromptGallery} aria-label="从提示词广场导入">
            <LibraryBig className="size-4" />
          </Button>
        </CanvasTooltip>
      )}
      <CanvasTooltip label="画布流程模板">
        <Button variant="ghost" size="icon-sm" onClick={onOpenTemplate} aria-label="画布流程模板">
          <LayoutDashboard className="size-4" />
        </Button>
      </CanvasTooltip>

      <div className="mx-1 h-5 w-px bg-border" />

      <CanvasTooltip label="撤销">
        <Button variant="ghost" size="icon-sm" disabled={!canUndo} onClick={onUndo} aria-label="撤销">
          <Undo2 className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="重做">
        <Button variant="ghost" size="icon-sm" disabled={!canRedo} onClick={onRedo} aria-label="重做">
          <Redo2 className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="搜索节点">
        <Button variant="ghost" size="icon-sm" onClick={onSearch} aria-label="搜索节点">
          <Search className="size-4" />
        </Button>
      </CanvasTooltip>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="排列节点"
          title="排列节点"
          disabled={nodeCount < 2}
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
        >
          <AlignStartVertical className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>对齐</DropdownMenuLabel>
            <ArrangeItem label="左对齐" icon={<AlignStartVertical />} disabled={selectedCount < 2} onClick={() => onArrange("align-left")} />
            <ArrangeItem label="水平居中" icon={<AlignCenterVertical />} disabled={selectedCount < 2} onClick={() => onArrange("align-center-horizontal")} />
            <ArrangeItem label="右对齐" icon={<AlignEndVertical />} disabled={selectedCount < 2} onClick={() => onArrange("align-right")} />
            <ArrangeItem label="顶对齐" icon={<AlignStartHorizontal />} disabled={selectedCount < 2} onClick={() => onArrange("align-top")} />
            <ArrangeItem label="垂直居中" icon={<AlignCenterHorizontal />} disabled={selectedCount < 2} onClick={() => onArrange("align-center-vertical")} />
            <ArrangeItem label="底对齐" icon={<AlignEndHorizontal />} disabled={selectedCount < 2} onClick={() => onArrange("align-bottom")} />
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>分布与排列</DropdownMenuLabel>
            <ArrangeItem label="水平等距" icon={<BetweenHorizontalStart />} disabled={selectedCount < 3} onClick={() => onArrange("distribute-horizontal")} />
            <ArrangeItem label="垂直等距" icon={<BetweenVerticalStart />} disabled={selectedCount < 3} onClick={() => onArrange("distribute-vertical")} />
            <ArrangeItem label="横向排列" icon={<Columns3 />} disabled={selectedCount < 2} onClick={() => onArrange("row")} />
            <ArrangeItem label="纵向排列" icon={<Rows3 />} disabled={selectedCount < 2} onClick={() => onArrange("column")} />
            <ArrangeItem label="紧凑网格" icon={<Grid2x2 />} disabled={selectedCount < 2} onClick={() => onArrange("grid")} />
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <ArrangeItem label="按链路自动布局" icon={<Workflow />} onClick={() => onArrange("graph")} />
        </DropdownMenuContent>
      </DropdownMenu>

      {selectedConfigCount > 1 && (
        <CanvasTooltip label={`生成所选配置（${selectedConfigCount}）`}>
          <Button variant="ghost" size="icon-sm" onClick={onGenerateSelected} aria-label="生成所选配置">
            <Sparkles className="size-4" />
          </Button>
        </CanvasTooltip>
      )}

      <div className="mx-1 h-5 w-px bg-border" />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="画布显示设置"
          title="画布显示设置"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
        >
          <SlidersHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>画布背景</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={backgroundMode} onValueChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}>
              <DropdownMenuRadioItem value="lines"><Grid2x2 />网格背景</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dots"><CircleDot />圆点背景</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="blank"><Square />空白背景</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={showImageInfo} onCheckedChange={(checked) => onShowImageInfoChange(Boolean(checked))}>
            <Info />显示图片信息
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {selectedCount > 0 && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <CanvasTooltip label={`删除选中（${selectedCount}）`}>
            <Button variant="destructive" size="icon-sm" onClick={onDelete} aria-label="删除选中">
              <Trash2 className="size-4" />
            </Button>
          </CanvasTooltip>
        </>
      )}
    </div>
  );
}

function ArrangeItem({ label, icon, disabled, onClick }: { label: string; icon: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <DropdownMenuItem disabled={disabled} onClick={onClick}>
      {icon}
      {label}
    </DropdownMenuItem>
  );
}
