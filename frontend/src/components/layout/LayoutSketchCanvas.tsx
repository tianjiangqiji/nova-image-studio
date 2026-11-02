'use client';

// 构图规范图形化框选
// 纯 DOM + pointer events 实现，坐标全部归一化到 0–1，与 layout-spec 的包围盒语义一致。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  boxFromPoints,
  clampLayoutBox,
  moveLayoutBox,
  parseAspectRatioValue,
  resizeLayoutBox,
  type LayoutBox,
  type LayoutObject,
} from '@/lib/layout-spec';

/** 每个物体使用的描边色，按索引循环 */
const BOX_COLORS = [
  '#3b82f6',
  '#f97316',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#ec4899',
] as const;

export function getLayoutBoxColor(index: number): string {
  return BOX_COLORS[index % BOX_COLORS.length];
}

type DragState =
  | { mode: 'create'; startX: number; startY: number; currentX: number; currentY: number }
  | { mode: 'move'; objectId: string; originBox: LayoutBox; startX: number; startY: number }
  | { mode: 'resize'; objectId: string; originBox: LayoutBox; startX: number; startY: number };

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const objectsRef = useRef(objects);

  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  const ratio = useMemo(() => parseAspectRatioValue(aspectRatio), [aspectRatio]);

  /** 把指针位置换算成归一化坐标（原点左上角，y 向下） */
  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return { x, y };
  }, []);

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      // 命中已有包围盒时不在此处新建
      if (target.closest('[data-layout-box]')) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const { x, y } = toNormalized(event.clientX, event.clientY);
      setDrag({ mode: 'create', startX: x, startY: y, currentX: x, currentY: y });
    },
    [toNormalized],
  );

  const handleBoxPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, object: LayoutObject, mode: 'move' | 'resize') => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      onSelect(object.id);
      const { x, y } = toNormalized(event.clientX, event.clientY);
      setDrag({ mode, objectId: object.id, originBox: object.box, startX: x, startY: y });
    },
    [onSelect, toNormalized],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
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

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative w-full select-none overflow-hidden rounded-lg border border-border bg-muted/30',
        'touch-none',
        className,
      )}
      style={{ aspectRatio: String(ratio) }}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
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
          在画布上拖拽即可创建物体包围盒
        </div>
      )}
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
