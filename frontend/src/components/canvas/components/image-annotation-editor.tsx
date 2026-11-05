'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Circle,
  Loader2,
  PenTool,
  Pipette,
  Square,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';

// ── Types ──────────────────────────────────────────────────────────────────

type Tool = 'brush' | 'rect' | 'ellipse';

interface Point {
  x: number;
  y: number;
}

type Annotation =
  | { id: string; type: 'brush'; color: string; size: number; points: Point[] }
  | { id: string; type: 'rect'; color: string; size: number; start: Point; end: Point }
  | { id: string; type: 'ellipse'; color: string; size: number; start: Point; end: Point };

interface ImageAnnotationEditorProps {
  src: string;
  title?: string;
  outputMode?: 'composite' | 'markup';
  initialPrompt?: string;
  onClose: () => void;
  onSubmit: (annotatedDataUrl: string, prompt: string, originalPng?: string) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_COLOR = '#e64032';
const DEFAULT_BRUSH_SIZE = 4;
const ANNO_SWATCHES = [
  '#e64032', '#ff0000', '#f59e0b', '#22c55e',
  '#3b82f6', '#a855f7', '#ec4899', '#ffffff',
];

// ── Color utilities (adapted from GifFrameTuner) ───────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function normalizeHex(input: string): string | null {
  let s = input.trim();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = normalizeHex(hex) ?? '#000000';
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsv({ r, g, b }: { r: number; g: number; b: number }): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb({ h, s, v }: { h: number; s: number; v: number }): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60) { rp = c; gp = x; }
  else if (h < 120) { rp = x; gp = c; }
  else if (h < 180) { gp = c; bp = x; }
  else if (h < 240) { gp = x; bp = c; }
  else if (h < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

// ── ColorPicker (adapted from GifFrameTuner) ───────────────────────────────

function ColorPicker({
  value,
  onChange,
  onPickFromImage,
  pickingFromImage,
}: {
  value: string;
  onChange: (hex: string) => void;
  onPickFromImage: () => void;
  pickingFromImage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const svRef = useRef<HTMLDivElement>(null);
  const svDragRef = useRef(false);

  const hsv = rgbToHsv(hexToRgb(value));

  const commitHsv = useCallback((h: number, s: number, v: number) => {
    onChange(rgbToHex(hsvToRgb({ h, s, v })));
  }, [onChange]);

  const commitHex = useCallback((raw: string) => {
    const n = normalizeHex(raw);
    if (n) onChange(n);
  }, [onChange]);

  const handleSvPointer = useCallback((clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = clamp01((clientX - rect.left) / rect.width);
    const v = clamp01(1 - (clientY - rect.top) / rect.height);
    commitHsv(hsv.h, s, v);
  }, [commitHsv, hsv.h]);

  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => { if (svDragRef.current) handleSvPointer(e.clientX, e.clientY); };
    const onUp = () => { svDragRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [open, handleSvPointer]);

  const hueColor = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="h-7 w-7 shrink-0 rounded-full border border-border shadow-sm outline-none ring-offset-background transition-all focus-visible:ring-2 focus-visible:ring-primary"
        style={{ background: value }}
        title="自定义颜色"
      />
      <PopoverContent align="end" className="z-[10000] w-56 space-y-3">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onPickFromImage();
          }}
          className={cn(
            'flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium transition-colors hover:bg-muted',
            pickingFromImage && 'border-primary text-primary',
          )}
        >
          <Pipette className="h-3.5 w-3.5" />
          {pickingFromImage ? '取消吸取颜色' : '从图片吸取颜色'}
        </button>

        {/* 饱和度 / 明度选择面板 */}
        <div
          ref={svRef}
          onMouseDown={e => { svDragRef.current = true; handleSvPointer(e.clientX, e.clientY); }}
          className="relative h-32 w-full cursor-crosshair rounded-md"
          style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
        >
          <span
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }}
          />
        </div>

        {/* 色相滑块 */}
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(hsv.h)}
          onChange={e => commitHsv(parseInt(e.target.value, 10), hsv.s, hsv.v)}
          className="h-3 w-full cursor-pointer appearance-none rounded-full"
          style={{ background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)' }}
        />

        {/* HEX 输入 + 预览 */}
        <div className="flex items-center gap-2">
          <span className="h-7 w-7 shrink-0 rounded-md border border-border" style={{ background: value }} />
          <input
            key={value}
            defaultValue={value}
            onBlur={e => commitHex(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value); }}
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs uppercase tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-primary"
            spellCheck={false}
          />
        </div>

        {/* 预设色板 */}
        <div className="flex flex-wrap gap-1.5">
          {ANNO_SWATCHES.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={cn(
                'h-5 w-5 rounded-md border transition-all',
                value.toLowerCase() === c ? 'ring-2 ring-primary ring-offset-1 ring-offset-popover' : 'border-border',
              )}
              style={{ background: c }}
              title={c}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Annotation drawing ─────────────────────────────────────────────────────

function drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation): void {
  ctx.strokeStyle = ann.color;
  ctx.fillStyle = ann.color;
  ctx.lineWidth = ann.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (ann.type === 'brush') {
    if (ann.points.length === 0) return;
    if (ann.points.length === 1) {
      // Draw a dot for single-point brush
      ctx.beginPath();
      ctx.arc(ann.points[0].x, ann.points[0].y, ann.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(ann.points[0].x, ann.points[0].y);
    for (let i = 1; i < ann.points.length; i++) {
      ctx.lineTo(ann.points[i].x, ann.points[i].y);
    }
    ctx.stroke();
  } else if (ann.type === 'rect') {
    const x = Math.min(ann.start.x, ann.end.x);
    const y = Math.min(ann.start.y, ann.end.y);
    const w = Math.abs(ann.end.x - ann.start.x);
    const h = Math.abs(ann.end.y - ann.start.y);
    ctx.strokeRect(x, y, w, h);
  } else if (ann.type === 'ellipse') {
    const cx = (ann.start.x + ann.end.x) / 2;
    const cy = (ann.start.y + ann.end.y) / 2;
    const rx = Math.max(0.5, Math.abs(ann.end.x - ann.start.x) / 2);
    const ry = Math.max(0.5, Math.abs(ann.end.y - ann.start.y) / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function scaleAnnotation(ann: Annotation, scaleX: number, scaleY: number): Annotation {
  return {
    ...ann,
    size: ann.size * Math.max(scaleX, scaleY),
    ...(ann.type === 'brush'
      ? { points: ann.points.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })) }
      : {
          start: { x: ann.start.x * scaleX, y: ann.start.y * scaleY },
          end: { x: ann.end.x * scaleX, y: ann.end.y * scaleY },
        }),
  };
}

function compositeImage(
  img: HTMLImageElement,
  annotations: Annotation[],
  displayWidth: number,
  displayHeight: number,
  transparent = false,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');

  // Draw the original image
  if (!transparent) ctx.drawImage(img, 0, 0);

  // Scale annotations from display coordinates to natural resolution
  const scaleX = img.naturalWidth / displayWidth;
  const scaleY = img.naturalHeight / displayHeight;

  for (const ann of annotations) {
    drawAnnotation(ctx, scaleAnnotation(ann, scaleX, scaleY));
  }

  return canvas.toDataURL('image/png');
}

function constructPrompt(userInput: string, annotations: Annotation[]): string {
  const colors = [...new Set(annotations.map(a => a.color.toLowerCase()))];
  const hasBrush = annotations.some(a => a.type === 'brush');
  const hasShape = annotations.some(a => a.type === 'rect' || a.type === 'ellipse');

  let toolDesc: string;
  if (hasBrush && hasShape) {
    toolDesc = '线条圈出部分/框选部分';
  } else if (hasBrush) {
    toolDesc = '线条圈出部分';
  } else {
    toolDesc = '框选部分';
  }

  const colorStr = colors.join('、');
  return `需求：${userInput}；用户选择部分为${colorStr}颜色${toolDesc}`;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ann-${crypto.randomUUID()}`;
  }
  return `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ── Main Component ─────────────────────────────────────────────────────────

export function ImageAnnotationEditor({ src, title, outputMode = 'composite', initialPrompt = '', onClose, onSubmit }: ImageAnnotationEditorProps) {
  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [userInput, setUserInput] = useState(initialPrompt);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [samplingColor, setSamplingColor] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageElRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const draftRef = useRef<Annotation | null>(null);
  const displaySizeRef = useRef({ width: 0, height: 0 });

  // ── Body scroll lock (same as GifFrameTuner) ──
  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('position');
      document.body.style.removeProperty('top');
      document.body.style.removeProperty('width');
      window.scrollTo(0, scrollY);
    };
  }, []);

  // ── Image pre-load (with CORS support for canvas operations) ──
  useEffect(() => {
    let cancelled = false;
    setImageLoaded(false);
    setImageError(false);
    setNaturalSize({ width: 0, height: 0 });

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imageElRef.current = img;
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      setImageLoaded(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      setImageError(true);
    };
    img.src = src;

    return () => { cancelled = true; };
  }, [src]);

  // ── Calculate display size ──
  useEffect(() => {
    if (!imageLoaded || !containerRef.current) return;
    const calculate = () => {
      const container = containerRef.current;
      if (!container || naturalSize.width === 0) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const aspectRatio = naturalSize.width / naturalSize.height;
      let dw = cw;
      let dh = dw / aspectRatio;
      if (dh > ch) {
        dh = ch;
        dw = dh * aspectRatio;
      }
      // Leave a small margin
      const margin = 8;
      if (dw > cw - margin) {
        dw = cw - margin;
        dh = dw / aspectRatio;
      }
      if (dh > ch - margin) {
        dh = ch - margin;
        dw = dh * aspectRatio;
      }
      const next = { width: Math.max(1, Math.floor(dw)), height: Math.max(1, Math.floor(dh)) };
      const previous = displaySizeRef.current;
      if (previous.width && previous.height && (previous.width !== next.width || previous.height !== next.height)) {
        const sx = next.width / previous.width;
        const sy = next.height / previous.height;
        setAnnotations(items => items.map(ann => scaleAnnotation(ann, sx, sy)));
        if (draftRef.current) draftRef.current = scaleAnnotation(draftRef.current, sx, sy);
      }
      displaySizeRef.current = next;
      setDisplaySize(next);
    };
    calculate();
    const ro = new ResizeObserver(calculate);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [imageLoaded, naturalSize]);

  // ── Canvas setup ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || displaySize.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = displaySize.width * dpr;
    canvas.height = displaySize.height * dpr;
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;
  }, [displaySize]);

  // ── Redraw function (kept in ref for use in event handlers) ──
  const redrawRef = useRef<() => void>(() => {});
  redrawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    for (const ann of annotations) {
      drawAnnotation(ctx, ann);
    }
    if (draftRef.current) {
      drawAnnotation(ctx, draftRef.current);
    }
  };

  // Redraw when annotations or display size change
  useEffect(() => { redrawRef.current(); }, [annotations, displaySize]);

  // ── Pointer handlers ──
  const getCanvasPoint = useCallback((e: React.PointerEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const sampleColorAt = useCallback((point: Point) => {
    const img = imageElRef.current;
    if (!img || !img.complete || displaySize.width === 0) return;
    const scaleX = img.naturalWidth / displaySize.width;
    const scaleY = img.naturalHeight / displaySize.height;
    const ix = Math.max(0, Math.min(img.naturalWidth - 1, Math.floor(point.x * scaleX)));
    const iy = Math.max(0, Math.min(img.naturalHeight - 1, Math.floor(point.y * scaleY)));
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 1;
    sampleCanvas.height = 1;
    const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;
    try {
      sctx.drawImage(img, ix, iy, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = sctx.getImageData(0, 0, 1, 1).data;
      setColor(rgbToHex({ r, g, b }));
    } catch {
      // CORS-tainted canvas — silently ignore
    }
    setSamplingColor(false);
  }, [displaySize]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (samplingColor) {
      const point = getCanvasPoint(e);
      sampleColorAt(point);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const point = getCanvasPoint(e);
    const id = makeId();
    if (tool === 'brush') {
      draftRef.current = { id, type: 'brush', color, size: brushSize, points: [point] };
    } else {
      draftRef.current = { id, type: tool, color, size: brushSize, start: point, end: point };
    }
    redrawRef.current();
  }, [tool, color, brushSize, samplingColor, getCanvasPoint, sampleColorAt]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!drawingRef.current || !draftRef.current) return;
    const point = getCanvasPoint(e);
    if (draftRef.current.type === 'brush') {
      draftRef.current.points.push(point);
    } else {
      draftRef.current.end = point;
    }
    redrawRef.current();
  }, [getCanvasPoint]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!drawingRef.current || !draftRef.current) return;
    const canvas = canvasRef.current;
    if (canvas) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    drawingRef.current = false;
    const draft = draftRef.current;
    draftRef.current = null;

    if (draft.type === 'brush' && draft.points.length > 0) {
      setAnnotations(prev => [...prev, draft]);
    } else if (
      (draft.type === 'rect' || draft.type === 'ellipse') &&
      (Math.abs(draft.end.x - draft.start.x) > 2 || Math.abs(draft.end.y - draft.start.y) > 2)
    ) {
      setAnnotations(prev => [...prev, draft]);
    } else {
      // Too small, discard
      redrawRef.current();
    }
  }, []);

  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    if (drawingRef.current) {
      handlePointerUp(e);
    }
  }, [handlePointerUp]);

  // ── Undo / Clear ──
  const handleUndo = useCallback(() => {
    setAnnotations(prev => prev.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    setAnnotations([]);
  }, []);

  // ── Submit ──
  const handleSubmit = useCallback(async () => {
    const img = imageElRef.current;
    if (!img || !img.complete || annotations.length === 0 || !userInput.trim() || displaySize.width === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const markupMode = outputMode === 'markup';
      if (markupMode && img.naturalWidth * img.naturalHeight > 16_777_216) {
        throw new Error('标注参考图不能超过 16,777,216 像素，请先缩小参考图。');
      }
      const dataUrl = compositeImage(img, annotations, displaySize.width, displaySize.height, markupMode);
      const prompt = markupMode ? userInput.trim() : constructPrompt(userInput.trim(), annotations);
      // 浏览器解码后按原始像素导出 PNG，统一 EXIF 方向，确保首图与透明标注严格对齐。
      const originalPng = markupMode ? compositeImage(img, [], displaySize.width, displaySize.height) : undefined;
      onSubmit(dataUrl, prompt, originalPng);
    } catch (err) {
      console.error('标注图片合成失败:', err);
      setSubmitError(err instanceof Error ? err.message : '标注导出失败，请重试');
      setSubmitting(false);
    }
  }, [annotations, userInput, displaySize, onSubmit, outputMode]);

  // ── Esc to close ──
  const requestClose = useCallback(() => {
    if (annotations.length > 0 || userInput.trim()) {
      setCloseConfirmOpen(true);
    } else {
      onClose();
    }
  }, [annotations.length, userInput, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (samplingColor) {
          setSamplingColor(false);
        } else {
          requestClose();
        }
      }
      // Ctrl+Z / Cmd+Z to undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        setAnnotations(prev => prev.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [samplingColor, requestClose]);

  // ── Derived ──
  const canSubmit = annotations.length > 0 && userInput.trim().length > 0 && !submitting && imageLoaded;
  const toolButtons: { tool: Tool; icon: typeof PenTool; label: string }[] = [
    { tool: 'brush', icon: PenTool, label: '画笔' },
    { tool: 'rect', icon: Square, label: '方框' },
    { tool: 'ellipse', icon: Circle, label: '椭圆' },
  ];

  return (
    <div className="fixed inset-0 z-[9999] flex select-none flex-col bg-background/95 backdrop-blur-sm">
      {/* 顶部工具栏 */}
      <div className="scrollbar-hide flex h-12 shrink-0 touch-pan-x select-none items-center gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-border bg-background/95 px-3 sm:px-4">
        <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-foreground">
          <PenTool className="h-4 w-4 text-primary" />
          <span className="hidden sm:inline">画笔标注</span>
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        {/* 工具选择 */}
        <div className="flex shrink-0 items-center gap-0.5">
          {toolButtons.map(({ tool: t, icon: Icon, label }) => (
            <button
              key={t}
              type="button"
              onClick={() => setTool(t)}
              className={cn(
                'flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors',
                tool === t
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              title={label}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        {/* 颜色选择 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {ANNO_SWATCHES.slice(0, 4).map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={cn(
                'h-6 w-6 rounded-full border transition-all',
                color.toLowerCase() === c
                  ? 'ring-2 ring-primary ring-offset-1 ring-offset-background'
                  : 'border-border',
              )}
              style={{ background: c }}
              title={c}
            />
          ))}
          <div className="mx-0.5 h-4 w-px bg-border" />
          <ColorPicker
            value={color}
            onChange={setColor}
            onPickFromImage={() => setSamplingColor(v => !v)}
            pickingFromImage={samplingColor}
          />
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        {/* 画笔粗细 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs text-muted-foreground">粗细</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={brushSize}
            onChange={e => setBrushSize(parseInt(e.target.value, 10))}
            className="h-1 w-20 cursor-pointer accent-primary"
          />
          <span className="min-w-[24px] text-center text-xs tabular-nums text-muted-foreground">
            {brushSize}px
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleUndo}
            disabled={annotations.length === 0}
            className="gap-1"
            title="撤销 (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
            <span className="hidden sm:inline">撤销</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={annotations.length === 0}
            className="gap-1"
            title="清空标注"
          >
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">清空</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={requestClose} title="关闭">
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* 编辑区 */}
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center p-3"
      >
        {samplingColor && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-md border border-primary/30 bg-background/90 px-3 py-1.5 text-xs text-foreground shadow-sm">
            点击图片吸取颜色
          </div>
        )}

        {imageError && (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <p className="text-sm">图片加载失败</p>
            <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
          </div>
        )}

        {!imageLoaded && !imageError && (
          <div className="flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {imageLoaded && displaySize.width > 0 && (
          <div
            className="relative"
            style={{ width: displaySize.width, height: displaySize.height }}
          >
            <img
              src={src}
              alt={title || ''}
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0"
              style={{
                cursor: samplingColor ? 'crosshair' : 'crosshair',
                touchAction: 'none',
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerLeave}
            />
          </div>
        )}
      </div>

      {/* 底部输入区 */}
      <div className="shrink-0 border-t border-border bg-background/95 p-3 sm:p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              修改需求
              {annotations.length > 0 && (
                <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  {annotations.length} 个标注
                </span>
              )}
            </span>
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={userInput}
              onChange={e => setUserInput(e.target.value)}
              placeholder='例如：移除画圈部分的物品'
              rows={2}
              className="resize-none"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (canSubmit) void handleSubmit();
                }
              }}
            />
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="gap-1.5 shrink-0"
              title={outputMode === 'markup' ? '保存独立透明标注并返回工作台' : '跳转到生图工作台并自动构造提示词'}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {outputMode === 'markup' ? '应用标注' : '开始修改'}
            </Button>
          </div>
          {submitError && <p role="alert" className="text-xs text-destructive">{submitError}</p>}
          {annotations.length > 0 && userInput.trim() && (
            <p className="text-[11px] text-muted-foreground">
              预览提示词：{outputMode === 'markup' ? userInput.trim() : constructPrompt(userInput.trim(), annotations)}
            </p>
          )}
          {annotations.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              请使用画笔、方框或椭圆在图片上标注需要修改的区域，并输入修改需求
            </p>
          )}
        </div>
      </div>

      {/* 关闭确认 */}
      {closeConfirmOpen && (
        <ConfirmDialog
          title="放弃标注？"
          message="直接关闭将不会保存已标注的内容。确定要关闭吗？"
          confirmText="放弃并关闭"
          cancelText="继续编辑"
          onConfirm={() => { setCloseConfirmOpen(false); onClose(); }}
          onCancel={() => setCloseConfirmOpen(false)}
        />
      )}
    </div>
  );
}
