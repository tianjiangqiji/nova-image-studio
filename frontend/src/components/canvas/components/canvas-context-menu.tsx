"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Copy, Crop, Eraser, FileText, Film, Grid3x3, Image as ImageIcon, Maximize2, Music, PaintBucket, RefreshCw, Rotate3d, Settings2, Sparkles, Square, Text, Trash2, Type, Upload } from "lucide-react";

import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "../types";

export type CanvasContextMenuActions = {
  onGenerate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDeleteImageOnly: () => void;
  onRetry: () => void;
  onCrop: () => void;
  onSplit: () => void;
  onUpscale: () => void;
  onAngle: () => void;
  onDeleteConnection: () => void;
  onToggleRenderMode?: () => void;
  onAiGenerateText?: (prompt: string) => void;
  onAnnotationChangeColor?: () => void;
  onAnnotationChangeFontSize?: () => void;
  onAddNodeAt?: (type: CanvasNodeType) => void;
  onConnectionCreate?: (type: CanvasNodeType) => void;
  /** 视频/音频素材节点：选择本地文件 */
  onUploadMedia?: () => void;
  onPasteAt?: () => void;
  canPaste?: boolean;
};

export function CanvasContextMenu({ state, node, onClose, actions }: { state: ContextMenuState | null; node?: CanvasNodeData; onClose: () => void; actions: CanvasContextMenuActions }) {
  useEffect(() => {
    if (!state) return;
    const handle = () => onClose();
    const handleKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", handle);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handle);
      window.removeEventListener("keydown", handleKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  const isImage = state.type === "node" && node?.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
  const canGenerate = state.type === "node" && node?.type === CanvasNodeType.Config;
  const canRetry = state.type === "node" && Boolean(node) && (node!.type === CanvasNodeType.Image || node!.type === CanvasNodeType.Video) && node!.metadata?.status === "error";
  const isText = state.type === "node" && node?.type === CanvasNodeType.Text;
  const isAnnotation = state.type === "node" && node?.type === CanvasNodeType.TextAnnotation;
  const isMediaNode = state.type === "node" && (node?.type === CanvasNodeType.Video || node?.type === CanvasNodeType.Audio);

  const items: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }[] = [];
  if (state.type === "connection-create") {
    items.push({ label: "图片", icon: <ImageIcon className="size-4" />, onClick: () => actions.onConnectionCreate?.(CanvasNodeType.Image) });
    items.push({ label: "视频", icon: <Film className="size-4" />, onClick: () => actions.onConnectionCreate?.(CanvasNodeType.Video) });
    items.push({ label: "音频", icon: <Music className="size-4" />, onClick: () => actions.onConnectionCreate?.(CanvasNodeType.Audio) });
    items.push({ label: "文本", icon: <FileText className="size-4" />, onClick: () => actions.onConnectionCreate?.(CanvasNodeType.Text) });
    items.push({ label: "注释", icon: <Square className="size-4" />, onClick: () => actions.onConnectionCreate?.(CanvasNodeType.TextAnnotation) });
    items.push({ label: "编排", icon: <Settings2 className="size-4" />, onClick: () => actions.onConnectionCreate?.(CanvasNodeType.Config) });
  } else if (state.type === "canvas") {
    items.push({ label: "在此添加图片节点", icon: <ImageIcon className="size-4" />, onClick: () => actions.onAddNodeAt?.(CanvasNodeType.Image) });
    items.push({ label: "在此添加视频节点", icon: <Film className="size-4" />, onClick: () => actions.onAddNodeAt?.(CanvasNodeType.Video) });
    items.push({ label: "在此添加音频节点", icon: <Music className="size-4" />, onClick: () => actions.onAddNodeAt?.(CanvasNodeType.Audio) });
    items.push({ label: "在此添加文本节点", icon: <FileText className="size-4" />, onClick: () => actions.onAddNodeAt?.(CanvasNodeType.Text) });
    items.push({ label: "在此添加生成配置", icon: <Settings2 className="size-4" />, onClick: () => actions.onAddNodeAt?.(CanvasNodeType.Config) });
    items.push({ label: "在此添加注释", icon: <Square className="size-4" />, onClick: () => actions.onAddNodeAt?.(CanvasNodeType.TextAnnotation) });
    if (actions.canPaste && actions.onPasteAt) items.push({ label: "粘贴到此处", icon: <Copy className="size-4" />, onClick: actions.onPasteAt });
  } else if (state.type === "connection") {
    items.push({ label: "删除连线", icon: <Trash2 className="size-4" />, onClick: actions.onDeleteConnection, danger: true });
  } else {
    if (canGenerate) items.push({ label: "生成", icon: <Sparkles className="size-4" />, onClick: actions.onGenerate });
    if (isMediaNode && actions.onUploadMedia) {
      items.push({
        label: node?.metadata?.storageKey ? "替换本地文件" : node?.type === CanvasNodeType.Audio ? "上传音频" : "上传视频",
        icon: <Upload className="size-4" />,
        onClick: actions.onUploadMedia,
      });
    }
    if (isImage) {
      items.push({ label: "裁剪", icon: <Crop className="size-4" />, onClick: actions.onCrop });
      items.push({ label: "分割", icon: <Grid3x3 className="size-4" />, onClick: actions.onSplit });
      items.push({ label: "放大", icon: <Maximize2 className="size-4" />, onClick: actions.onUpscale });
      items.push({ label: "视角", icon: <Rotate3d className="size-4" />, onClick: actions.onAngle });
      items.push({ label: "删除图片", icon: <Eraser className="size-4" />, onClick: actions.onDeleteImageOnly });
    }
    if (isText) {
      if (actions.onToggleRenderMode) {
        items.push({ label: "切换 Markdown / 纯文本", icon: <Text className="size-4" />, onClick: actions.onToggleRenderMode });
      }
    }
    if (isAnnotation) {
      if (actions.onAnnotationChangeColor) {
        items.push({ label: "更换背景色", icon: <PaintBucket className="size-4" />, onClick: actions.onAnnotationChangeColor });
      }
      if (actions.onAnnotationChangeFontSize) {
        items.push({ label: "调整字号", icon: <Type className="size-4" />, onClick: actions.onAnnotationChangeFontSize });
      }
    }
    if (canRetry) items.push({ label: "重新生成", icon: <RefreshCw className="size-4" />, onClick: actions.onRetry });
    items.push({ label: "复制", icon: <Copy className="size-4" />, onClick: actions.onDuplicate });
    items.push({ label: "删除", icon: <Trash2 className="size-4" />, onClick: actions.onDelete, danger: true });
  }

  return createPortal(
    <div
      data-canvas-no-zoom
      className="fixed z-[130] min-w-40 animate-in overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl duration-100 fade-in-0 zoom-in-95"
      style={{ left: state.x, top: state.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-100 hover:bg-muted active:scale-[0.98] ${item.danger ? "text-destructive hover:bg-destructive/10" : "text-foreground"}`}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
