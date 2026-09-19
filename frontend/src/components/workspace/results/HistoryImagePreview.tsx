'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, ImagePlus, Maximize2, Pencil, Wand2, X } from 'lucide-react';
import { runImageAction, applyAnnotatedImageAsReference, type ImageActionPayload } from '@/lib/image-actions';
import { ImageAnnotationEditor } from '@/components/canvas/components/image-annotation-editor';
import { useBodyScrollLock } from '@/lib/scroll-lock';

function getDistance(t1: { clientX: number; clientY: number }, t2: { clientX: number; clientY: number }) {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function clampImageIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  const normalized = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(normalized, 0), length - 1);
}

interface HistoryImagePreviewProps {
  images: string[];
  alt: string;
  onClose: () => void;
  onDownload?: (index: number) => void;
  initialIndex?: number;
  actionPayloads?: ImageActionPayload[];
  onIndexChange?: (index: number) => void;
  showDownload?: boolean;
  showCopy?: boolean;
  showAddToAssets?: boolean;
  showUseAsReference?: boolean;
}

export function HistoryImagePreview({
  images,
  alt,
  onClose,
  onDownload,
  initialIndex = 0,
  actionPayloads,
  onIndexChange,
  showDownload = true,
  showCopy = true,
  showAddToAssets = true,
  showUseAsReference = true,
}: HistoryImagePreviewProps) {
  const [currentIndex, setCurrentIndex] = useState(() => clampImageIndex(initialIndex, images.length));
  const [scale, setScaleState] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [showAnnotationEditor, setShowAnnotationEditor] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const scaleRef = useRef(1);
  const posRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const posStart = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);

  // Touch refs for pinch-to-zoom and single-finger drag
  const touchRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    startX: 0,
    startY: 0,
    startPosX: 0,
    startPosY: 0,
    isSingleTouch: false,
  });

  const currentSrc = images[currentIndex];
  const isMultiple = images.length > 1;
  const currentPayload = actionPayloads?.[currentIndex];

  useEffect(() => {
    onIndexChange?.(currentIndex);
  }, [currentIndex, onIndexChange]);

  const applyTransform = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    const currentScale = scaleRef.current;
    const currentPos = posRef.current;
    image.style.transform = `translate3d(${currentPos.x}px, ${currentPos.y}px, 0) scale(${currentScale})`;
  }, []);

  const scheduleTransform = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      applyTransform();
    });
  }, [applyTransform]);

  const setScale = useCallback((value: number | ((prev: number) => number)) => {
    setScaleState(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      scaleRef.current = next;
      scheduleTransform();
      return next;
    });
  }, [scheduleTransform]);

  const setPos = useCallback((value: { x: number; y: number }) => {
    posRef.current = value;
    scheduleTransform();
  }, [scheduleTransform]);

  const resetView = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [setScale, setPos]);

  const zoomIn = useCallback(() => setScale(prev => Math.min(prev + 0.5, 10)), [setScale]);
  const zoomOut = useCallback(() => setScale(prev => {
    const next = prev - 0.5;
    return next <= 1 ? 1 : next;
  }), [setScale]);

  const nextImage = useCallback(() => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(index => index + 1);
      resetView();
    }
  }, [currentIndex, images.length, resetView]);

  const prevImage = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(index => index - 1);
      resetView();
    }
  }, [currentIndex, resetView]);

  useBodyScrollLock();

  useLayoutEffect(() => {
    applyTransform();
  }, [applyTransform, currentIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') prevImage();
      if (event.key === 'ArrowRight') nextImage();
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextImage, onClose, prevImage]);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY < 0) {
      zoomIn();
    } else {
      zoomOut();
    }
  }, [zoomIn, zoomOut]);

  // Touch handlers for pinch-to-zoom and single-finger drag
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      touchRef.current.initialDistance = getDistance(e.touches[0], e.touches[1]);
      touchRef.current.initialScale = scaleRef.current;
    } else if (e.touches.length === 1 && scaleRef.current > 1) {
      touchRef.current.isSingleTouch = true;
      touchRef.current.startX = e.touches[0].clientX;
      touchRef.current.startY = e.touches[0].clientY;
      touchRef.current.startPosX = posRef.current.x;
      touchRef.current.startPosY = posRef.current.y;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = getDistance(e.touches[0], e.touches[1]);
      const ratio = dist / touchRef.current.initialDistance;
      setScale(Math.min(Math.max(touchRef.current.initialScale * ratio, 1), 10));
    } else if (e.touches.length === 1 && touchRef.current.isSingleTouch && scaleRef.current > 1) {
      e.preventDefault();
      const dx = e.touches[0].clientX - touchRef.current.startX;
      const dy = e.touches[0].clientY - touchRef.current.startY;
      setPos({
        x: touchRef.current.startPosX + dx,
        y: touchRef.current.startPosY + dy,
      });
    }
  }, [setScale, setPos]);

  const handleTouchEnd = useCallback(() => {
    touchRef.current.isSingleTouch = false;
  }, []);

  // Mouse drag handlers
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    draggingRef.current = true;
    setDragging(true);
    dragStart.current = { x: event.clientX, y: event.clientY };
    posStart.current = { ...posRef.current };
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = event.clientX - dragStart.current.x;
    const dy = event.clientY - dragStart.current.y;
    setPos({
      x: posStart.current.x + dx,
      y: posStart.current.y + dy,
    });
  }, [setPos]);

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
  }, []);

  const handleAnnotationSubmit = useCallback((annotatedDataUrl: string, prompt: string) => {
    setShowAnnotationEditor(false);
    void applyAnnotatedImageAsReference(annotatedDataUrl, prompt).then(() => {
      onClose();
    }).catch((err) => {
      console.error('标注图片发送失败:', err);
    });
  }, [onClose]);

  if (showAnnotationEditor) {
    return (
      <ImageAnnotationEditor
        src={currentSrc}
        title={alt}
        onClose={() => setShowAnnotationEditor(false)}
        onSubmit={handleAnnotationSubmit}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex select-none items-center justify-center bg-black/80"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
      }}
      onWheel={handleWheel}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/70 transition-colors hover:bg-black/60 hover:text-white"
      >
        <X className="w-5 h-5" />
      </button>

      {isMultiple && (
        <>
          <button
            onClick={prevImage}
            disabled={currentIndex === 0}
            className="absolute left-4 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/70 transition-colors hover:bg-black/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={nextImage}
            disabled={currentIndex === images.length - 1}
            className="absolute right-4 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/70 transition-colors hover:bg-black/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}

      {isMultiple && (
        <div className="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 backdrop-blur-sm">
          <span className="text-sm tabular-nums text-white/80">{currentIndex + 1} / {images.length}</span>
        </div>
      )}

      <div className="absolute bottom-6 left-1/2 z-10 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full bg-black/50 px-2 py-1.5 backdrop-blur-sm">
        <button onClick={zoomOut} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="缩小">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" /></svg>
        </button>
        <span className="min-w-[44px] text-center text-xs tabular-nums text-white/80">{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="放大">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></svg>
        </button>
        <div className="mx-1 h-4 w-px bg-white/20" />
        <button onClick={resetView} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="重置视图">
          <Maximize2 className="w-4 h-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-white/20" />
        <button onClick={() => setShowAnnotationEditor(true)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="画笔标注编辑">
          <Pencil className="w-4 h-4" />
        </button>
        {(showDownload && (onDownload || currentPayload)) && (
          <>
            <div className="mx-1 h-4 w-px bg-white/20" />
            <button
              onClick={() => {
                if (currentPayload) void runImageAction('download', currentPayload);
                else onDownload?.(currentIndex);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              title="下载图片"
            >
              <Download className="w-4 h-4" />
            </button>
          </>
        )}
        {currentPayload && showCopy && (
          <button onClick={() => void runImageAction('copy', currentPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="复制图片">
            <Copy className="w-4 h-4" />
          </button>
        )}
        {currentPayload && showAddToAssets && (
          <button onClick={() => void runImageAction('add-to-assets', currentPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="添加到素材库">
            <ImagePlus className="w-4 h-4" />
          </button>
        )}
        {currentPayload && showUseAsReference && (
          <button onClick={() => void runImageAction('use-as-reference', currentPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white" title="作为图生图参考">
            <Wand2 className="w-4 h-4" />
          </button>
        )}
      </div>

      <div
        className="h-screen w-screen overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        <img
          ref={imageRef}
          src={currentSrc}
          alt={alt}
          draggable={false}
          className="h-screen w-screen origin-center object-contain will-change-transform"
          style={{ transition: dragging ? 'none' : 'transform 120ms ease-out' }}
          onClick={event => event.stopPropagation()}
        />
      </div>
    </div>
  );
}
