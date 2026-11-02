'use client';

// 构图规范图形化框选
// 全屏视口：有效区域按画布比例呈现，滚轮/工具条缩放，面板模式或 Alt/中键拖动平移；
// 包围盒坐标仍归一化在有效区域 0–1 内，与 layout-spec 语义一致。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hand, Maximize, MousePointer2, ZoomIn, ZoomOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  boxFromPoints,
  clampLayoutBox,
  getLayoutBoxColor,
  moveLayoutBox,
  parseAspectRatioValue,
  resizeLayoutBox,
  type LayoutBox,
  type LayoutObject,
} from '@/lib/layout-spec';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

type DragState =
  | { mode: 'create'; startX: number; startY: number; currentX: number; currentY: number }
  | { mode: 'move'; objectId: string; originBox: LayoutBox; startX: number; startY: number }
  | { mode: 'resize'; objectId: string; originBox: LayoutBox; startX: number; startY: number }
  | { mode: 'pan'; startClientX: number; startClientY: number; originX: number; originY: number };

type ToolMode = 'select' | 'pan';

interface LayoutSketchCanvasProps {
  objects: LayoutObject[];
  /** 画布比例，例如 '1:1'、'16:9' */
  aspectRatio?: string;
  /** 可选底图，用于对齐参考图构图 */
  backgroundImageUrl?: string;
  selectedId?: string;
  onChange: (objects: LayoutObject[]) => void;
  onSelect: (objectId: string) => void;
  className?: string;
}

export function LayoutSketchCanvas({
  objects,
  aspectRatio,
  backgroundImageUrl,
  selectedId,
  onChange,
  onSelect,
  className,
}: LayoutSketchCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [tool, setTool] = useState<ToolMode>('select');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitSize, setFitSize] = useState({ w: 0, h: 0 });
  const objectsRef = useRef(objects);

  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  const ratio = useMemo(() => parseAspectRatioValue(aspectRatio), [aspectRatio]);

  // 有效区域基准尺寸 = 保持画布比例、恰好填满视口的最大矩形
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch) return;
      const w = Math.min(cw, ch * ratio);
      setFitSize({ w, h: w / ratio });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ratio]);

  /** 把指针位置换算成有效区域内的归一化坐标（原点左上角，y 向下） */
  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return { x, y };
  }, []);

  const applyZoom = useCallback((next: number) => {
    setZoom(() => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setZoom((prev) => {
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * factor));
      });
    },
    [],
  );

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 中键 / Alt / 面板模式 → 平移视口
      if (event.button === 1 || event.altKey || tool === 'pan') {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({
          mode: 'pan',
          startClientX: event.clientX,
          startClientY: event.clientY,
          originX: pan.x,
          originY: pan.y,
        });
        return;
      }
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      // 命中已有包围盒时不在此处新建
      if (target.closest('[data-layout-box]')) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const { x, y } = toNormalized(event.clientX, event.clientY);
      setDrag({ mode: 'create', startX: x, startY: y, currentX: x, currentY: y });
    },
    [pan, tool, toNormalized],
  );

  const handleBoxPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, object: LayoutObject, mode: 'move' | 'resize') => {
      // Alt / 中键 / 面板模式下不拦截，让事件冒泡给视口平移
      if (tool === 'pan' || event.altKey || event.button !== 0) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      onSelect(object.id);
      const { x, y } = toNormalized(event.clientX, event.clientY);
      setDrag({ mode, objectId: object.id, originBox: object.box, startX: x, startY: y });
    },
    [onSelect, tool, toNormalized],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      if (drag.mode === 'pan') {
        setPan({
          x: drag.originX + event.clientX - drag.startClientX,
          y: drag.originY + event.clientY - drag.startClientY,
        });
        return;
      }
      const { x, y } = toNormalized(event.clientX, event.clientY);
      if (drag.mode === 'create') {
        setDrag({ ...drag, currentX: x, currentY: y });
        return;
      }
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      const nextBox =
        drag.mode === 'move'
          ? moveLayoutBox(drag.originBox, dx, dy)
          : resizeLayoutBox(drag.originBox, dx, dy);
      onChange(objectsRef.current.map((item) => (item.id === drag.objectId ? { ...item, box: nextBox } : item)));
    },
    [drag, onChange, toNormalized],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (drag.mode === 'create') {
        const box = boxFromPoints(drag.startX, drag.startY, drag.currentX, drag.currentY);
        // 拖拽过小视为误触，不生成新物体
        if (box.w > 0.03 && box.h > 0.03) {
          const used = new Set(objectsRef.current.map((item) => item.id));
          let index = 1;
          while (used.has(`obj_${index}`)) index += 1;
          const newObject: LayoutObject = { id: `obj_${index}`, label: `物体${index}`, box: clampLayoutBox(box) };
          onChange([...objectsRef.current, newObject]);
          onSelect(newObject.id);
        }
      }
      setDrag(null);
    },
    [drag, onChange, onSelect],
  );

  const draftBox = drag?.mode === 'create' ? boxFromPoints(drag.startX, drag.startY, drag.currentX, drag.currentY) : null;
  const isPanning = drag?.mode === 'pan';

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative h-full w-full touch-none overflow-hidden rounded-lg border border-border bg-muted/40',
        isPanning ? 'cursor-grabbing' : tool === 'pan' ? 'cursor-grab' : 'cursor-crosshair',
        className,
      )}
      onWheel={handleWheel}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* 有效区域：按画布比例的矩形，缩放改变实际尺寸、平移改变位置 */}
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: fitSize.w * zoom,
          height: fitSize.h * zoom,
          transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
        }}
      >
        <div ref={stageRef} className="relative h-full w-full overflow-hidden bg-background/80 shadow-sm ring-1 ring-border">
          {backgroundImageUrl && (
            <img
              src={backgroundImageUrl}
              alt=""
              className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-60"
              draggable={false}
            />
          )}

          {/* 参考网格 */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/3 top-0 h-full w-px bg-border/60" />
            <div className="absolute left-2/3 top-0 h-full w-px bg-border/60" />
            <div className="absolute left-0 top-1/3 h-px w-full bg-border/60" />
            <div className="absolute left-0 top-2/3 h-px w-full bg-border/60" />
          </div>

          {objects.map((object, index) => {
            const color = getLayoutBoxColor(index);
            const isSelected = object.id === selectedId;
            return (
              <div
                key={object.id}
                data-layout-box
                className={cn(
                  'absolute cursor-move border-2 transition-shadow',
                  isSelected ? 'shadow-[0_0_0_2px_rgba(59,130,246,0.35)]' : '',
                )}
                style={{
                  left: `${object.box.x * 100}%`,
                  top: `${object.box.y * 100}%`,
                  width: `${object.box.w * 100}%`,
                  height: `${object.box.h * 100}%`,
                  borderColor: color,
                  backgroundColor: `${color}1a`,
                }}
                onPointerDown={(event) => handleBoxPointerDown(event, object, 'move')}
              >
                <span
                  className="absolute -top-px left-0 max-w-full truncate rounded-br px-1 py-0.5 text-[10px] font-medium leading-tight text-white"
                  style={{ backgroundColor: color }}
                >
                  {object.label}
                </span>
                <div
                  className="absolute bottom-0 right-0 size-3 translate-x-1/2 translate-y-1/2 cursor-nwse-resize rounded-sm border-2 bg-background"
                  style={{ borderColor: color }}
                  onPointerDown={(event) => handleBoxPointerDown(event, object, 'resize')}
                />
              </div>
            );
          })}

          {draftBox && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
              style={{
                left: `${draftBox.x * 100}%`,
                top: `${draftBox.y * 100}%`,
                width: `${draftBox.w * 100}%`,
                height: `${draftBox.h * 100}%`,
              }}
            />
          )}

          {objects.length === 0 && !draftBox && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-muted-foreground">
              在有效区域内拖拽即可创建物体包围盒
            </div>
          )}
        </div>
      </div>

      {/* 左下角悬浮工具条：选择/面板、缩放、适应窗口 */}
      <div
        className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover/90 p-1 shadow-md backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          size="icon-xs"
          variant={tool === 'select' ? 'default' : 'ghost'}
          onClick={() => setTool('select')}
          aria-label="选择模式"
          title="选择模式：拖拽新建 / 移动包围盒"
        >
          <MousePointer2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant={tool === 'pan' ? 'default' : 'ghost'}
          onClick={() => setTool('pan')}
          aria-label="平移模式"
          title="平移模式：拖拽移动视口（也可随时按住 Alt 或用中键）"
        >
          <Hand className="size-3.5" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => applyZoom(zoom / ZOOM_STEP)}
          aria-label="缩小"
          disabled={zoom <= MIN_ZOOM}
        >
          <ZoomOut className="size-3.5" />
        </Button>
        <span className="w-11 text-center text-[10px] tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => applyZoom(zoom * ZOOM_STEP)}
          aria-label="放大"
          disabled={zoom >= MAX_ZOOM}
        >
          <ZoomIn className="size-3.5" />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" onClick={resetView} aria-label="适应窗口" title="适应窗口">
          <Maximize className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** 键盘删除支持：由父组件在选中态下调用 */
export function useLayoutDeleteKey(selectedId: string | undefined, onDelete: (id: string) => void) {
  useEffect(() => {
    if (!selectedId) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      onDelete(selectedId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDelete, selectedId]);
}
