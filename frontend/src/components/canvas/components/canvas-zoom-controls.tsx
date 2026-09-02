"use client";

import type { ReactNode } from "react";
import { Compass, Focus, HelpCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { canvasTheme } from "../lib/canvas-theme";
import { CanvasTooltip } from "./canvas-ui";

type CanvasZoomControlsProps = {
  scale: number;
  onScaleChange: (scale: number) => void;
  onReset: () => void;
  isMiniMapOpen: boolean;
  onToggleMiniMap: () => void;
};

export function CanvasZoomControls({ scale, onScaleChange, onReset, isMiniMapOpen, onToggleMiniMap }: CanvasZoomControlsProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const theme = canvasTheme;

  return (
    <div className="absolute bottom-5 left-5 z-50 animate-in duration-200 fade-in-0 slide-in-from-bottom-2" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <div className="flex h-14 items-center gap-1 rounded-xl border border-border bg-card/95 px-2 shadow-lg backdrop-blur transition-shadow duration-200 hover:shadow-xl">
        <CanvasTooltip label={isMiniMapOpen ? "关闭小地图" : "打开小地图"}>
          <Button variant={isMiniMapOpen ? "secondary" : "ghost"} size="icon-sm" onClick={onToggleMiniMap} aria-label={isMiniMapOpen ? "关闭小地图" : "打开小地图"}>
            <Compass className="size-4" />
          </Button>
        </CanvasTooltip>
        <CanvasTooltip label="重置视图">
          <Button variant="ghost" size="icon-sm" onClick={onReset} aria-label="重置视图">
            <Focus className="size-4" />
          </Button>
        </CanvasTooltip>
        <input
          type="range"
          min="5"
          max="500"
          step="1"
          value={Math.round(scale * 100)}
          className="w-24"
          style={{ accentColor: theme.node.activeStroke }}
          onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
          aria-label="放大/缩小画布"
        />
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
        <CanvasTooltip label="快捷键">
          <Button variant={shortcutsOpen ? "secondary" : "ghost"} size="icon-sm" onClick={() => setShortcutsOpen(true)} aria-label="快捷键">
            <HelpCircle className="size-4" />
          </Button>
        </CanvasTooltip>
      </div>
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>快捷键</DialogTitle>
          </DialogHeader>
          <div className={cn("space-y-3 border-t border-border pt-4 text-sm")}>
            <Shortcut label="选择模式 + 空白拖动" value="框选节点" />
            <Shortcut label="抓手模式 + 空白拖动" value="平移视图" />
            <Shortcut label="空格 + 拖动" value="临时平移视图" />
            <Shortcut label="鼠标中键拖动" value="平移视图" />
            <Shortcut label="滚轮" value="缩放画布" />
            <Shortcut label="Shift / Ctrl / Cmd + 点击" value="追加选择节点" />
            <Shortcut label="Ctrl / Cmd + C / V" value="复制 / 粘贴节点" />
            <Shortcut label="Ctrl / Cmd + Z" value="撤销" />
            <Shortcut label="Ctrl / Cmd + Shift + Z" value="重做" />
            <Shortcut label="Ctrl / Cmd + F" value="搜索并定位节点" />
            <Shortcut label="Delete / Backspace" value="删除选中" />
            <Shortcut label="双击节点标题" value="原位编辑标题" />
            <Shortcut label="Enter / 失焦" value="保存标题" />
            <Shortcut label="Escape" value="取消标题修改" />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Shortcut({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-base font-medium">{label}</span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  );
}
