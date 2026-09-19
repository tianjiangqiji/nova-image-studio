'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Loader2, ExternalLink, Copy, Check, ChevronLeft, ChevronRight, Maximize2, X, Tag, Download, ImagePlus, Wand2, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ImageHoverActions } from '@/components/workspace/results/ImageHoverActions';
import { runImageAction, dispatchImageActionToast, type ImageActionPayload } from '@/lib/image-actions';
import { addTextAsset } from '@/lib/asset-store';
import { useBodyScrollLock } from '@/lib/scroll-lock';
import type { PromptGalleryItem } from '@/lib/prompt-gallery-types';

export type { PromptGalleryItem };

function makePromptGalleryImagePayload(
  prompt: PromptGalleryItem & { uniqueKey: string },
  imageUrl: string,
  index: number,
): ImageActionPayload {
  return {
    id: `${prompt.uniqueKey}-${index}`,
    name: `${prompt.title || '提示词广场图片'}-${index + 1}`,
    src: imageUrl,
    sourceKind: 'prompt-gallery',
    sourceLabel: '提示词广场',
    sourceRef: `${prompt.uniqueKey}:${index}`,
    prompt: prompt.content,
  };
}

export const PromptCard = memo(function PromptCard({ 
  prompt, 
  onShowDetail,
  onShowImages,
  imageCache,
  onImageLoad
}: { 
  prompt: PromptGalleryItem & { uniqueKey: string };
  onShowDetail: () => void;
  onShowImages: (initialIndex?: number) => void;
  imageCache: Set<string>;
  onImageLoad: (url: string) => void;
}) {
  const [imageIndex, setImageIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const hasMultipleImages = prompt.images.length > 1;
  const currentImageUrl = prompt.images[imageIndex];
  const isCached = imageCache.has(currentImageUrl);
  const imageLoaded = isCached;
  const currentPayload = makePromptGalleryImagePayload(prompt, currentImageUrl, imageIndex);

  // Intersection Observer for lazy rendering
  useEffect(() => {
    if (!cardRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
          }
        });
      },
      {
        rootMargin: '200px', // Start loading 200px before entering viewport
        threshold: 0.01
      }
    );

    observer.observe(cardRef.current);

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleImageLoaded = () => {
    onImageLoad(currentImageUrl);
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(prompt.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const nextImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImageIndex((prev) => (prev + 1) % prompt.images.length);
  };

  const prevImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImageIndex((prev) => (prev - 1 + prompt.images.length) % prompt.images.length);
  };

  return (
    <div ref={cardRef} className="bg-card border border-border rounded-xl overflow-hidden hover:shadow-lg transition-shadow">
      {/* Image */}
      {prompt.images.length > 0 && (
        <div 
          className="relative aspect-square bg-muted cursor-pointer group"
          onClick={() => onShowImages(imageIndex)}
        >
          {isVisible ? (
            <>
              {!imageLoaded && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              )}
              <img
                src={currentImageUrl}
                alt={prompt.title}
                className={`w-full h-full object-cover transition-opacity ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
                loading="lazy"
                onLoad={handleImageLoaded}
              />
            </>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-12 h-12 bg-muted-foreground/10 rounded-lg" />
            </div>
          )}
          
          <ImageHoverActions
            payload={currentPayload}
            onPreview={() => onShowImages(imageIndex)}
            showDownload
            showAddToAssets
            showUseAsReference
          />

          {/* Image navigation */}
          {hasMultipleImages && (
            <>
              <button
                onClick={prevImage}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={nextImage}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 rounded-full px-2 py-0.5">
                <span className="text-white text-xs">{imageIndex + 1} / {prompt.images.length}</span>
              </div>
            </>
          )}

          {/* External link */}
          <a
            href={currentImageUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors opacity-0 group-hover:opacity-100"
            title="在新标签页打开"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}

      {/* Content */}
      <div className="p-3 space-y-2">
        {/* Title */}
        <h3 
          className="font-semibold text-sm line-clamp-1 cursor-pointer hover:text-primary transition-colors"
          onClick={onShowDetail}
          title={prompt.title}
        >
          {prompt.title}
        </h3>

        {/* Tags */}
        <div className="flex flex-wrap gap-1">
          {prompt.tags.slice(0, 3).map(tag => (
            <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0">
              {tag}
            </Badge>
          ))}
          {prompt.tags.length > 3 && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0">
              +{prompt.tags.length - 3}
            </Badge>
          )}
        </div>

        {/* Prompt preview */}
        <p 
          className="text-xs text-muted-foreground line-clamp-2 cursor-pointer hover:text-foreground transition-colors"
          onClick={onShowDetail}
        >
          {prompt.content}
        </p>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-2 flex-1 mr-2 min-w-0">
            <span className="text-xs text-muted-foreground truncate">
              {prompt.contributor || '未知作者'}
            </span>
            {prompt.sourceUrl && (
              <a
                href={prompt.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="来源"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-7 px-2 flex-shrink-0"
            title="复制提示词"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
});

export function PromptDetailModal({ 
  prompt, 
  onClose 
}: { 
  prompt: PromptGalleryItem & { uniqueKey: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useBodyScrollLock();

  // Trigger mount animation
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setIsMounted(true);
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToAssets = async () => {
    try {
      await addTextAsset({
        content: prompt.content,
        sourceKind: 'prompt-gallery',
        sourceLabel: '提示词广场',
        sourceRef: prompt.uniqueKey,
      });
      setSaved(true);
      dispatchImageActionToast('提示词素材已保存', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  };

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 150); // Match animation duration
  };

  return (
    <div 
      className={`fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 transition-opacity duration-150 ${
        isMounted && !isClosing ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ 
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        overflow: 'auto',
        willChange: 'opacity'
      }}
      onClick={handleClose}
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div 
        className={`bg-card border border-border rounded-xl max-w-3xl w-full max-h-[80vh] overflow-y-auto shadow-lg transition-all duration-150 ${
          isMounted && !isClosing ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
        style={{ willChange: 'transform, opacity' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border p-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{prompt.title}</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Tags */}
          <div className="flex flex-wrap gap-2">
            {prompt.tags.map(tag => (
              <Badge key={tag} variant="secondary">
                <Tag className="w-3 h-3 mr-1" />
                {tag}
              </Badge>
            ))}
          </div>

          {/* Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">提示词</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSaveToAssets()}
                  className="h-7"
                >
                  {saved ? (
                    <>
                      <Check className="w-3.5 h-3.5 mr-1.5 text-success" />
                      已保存
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5 mr-1.5" />
                      存素材
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  className="h-7"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 mr-1.5 text-success" />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 mr-1.5" />
                      复制
                    </>
                  )}
                </Button>
              </div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-sm whitespace-pre-wrap">
              {prompt.content}
            </div>
          </div>

          {/* Notes */}
          {prompt.notes && (
            <div className="space-y-2">
              <span className="text-sm font-medium">备注</span>
              <div className="bg-muted/50 rounded-lg p-3 text-sm">
                {prompt.notes}
              </div>
            </div>
          )}

          {/* Contributor */}
          {prompt.contributor && (
            <div className="text-sm text-muted-foreground">
              贡献者：{prompt.contributor}
            </div>
          )}

          {/* Source */}
          {prompt.sourceUrl && (
            <div className="text-sm text-muted-foreground flex items-center gap-1.5">
              <span>来源：</span>
              <a
                href={prompt.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline flex items-center gap-1"
              >
                {prompt.source || 'GitHub'}
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          {/* Category */}
          {prompt.category && (
            <div className="text-sm text-muted-foreground">
              分类：{prompt.category}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PromptGalleryImagePreviewModal({
  images,
  title,
  prompt,
  initialIndex = 0,
  onClose
}: {
  images: string[];
  title: string;
  prompt: PromptGalleryItem & { uniqueKey: string };
  initialIndex?: number;
  onClose: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(() => (
    images.length > 0 ? Math.min(Math.max(initialIndex, 0), images.length - 1) : 0
  ));
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const posStartRef = useRef({ x: 0, y: 0 });
  const closeRef = useRef<() => void>(() => undefined);
  const currentIndexRef = useRef(currentIndex);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  const currentSrc = images[currentIndex];
  const isMultiple = images.length > 1;
  const currentPayload = makePromptGalleryImagePayload(prompt, currentSrc, currentIndex);

  const resetView = () => { 
    setScale(1); 
    setPos({ x: 0, y: 0 }); 
  };

  const zoomIn = () => setScale(s => Math.min(s + 0.5, 10));
  const zoomOut = () => setScale(s => { const n = s - 0.5; return n <= 1 ? 1 : n; });

  const nextImage = () => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(i => i + 1);
      resetView();
    }
  };

  const prevImage = () => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1);
      resetView();
    }
  };

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 150); // Match animation duration
  }, [onClose]);
  useEffect(() => {
    closeRef.current = handleClose;
  }, [handleClose]);

  useBodyScrollLock();

  // Trigger mount animation and handle keyboard events
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setIsMounted(true);
    });
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && currentIndexRef.current > 0) {
        setCurrentIndex(i => i - 1);
        setScale(1);
        setPos({ x: 0, y: 0 });
      }
      if (e.key === 'ArrowRight' && currentIndexRef.current < images.length - 1) {
        setCurrentIndex(i => i + 1);
        setScale(1);
        setPos({ x: 0, y: 0 });
      }
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [images.length]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    posStartRef.current = { x: pos.x, y: pos.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPos({
      x: posStartRef.current.x + dx,
      y: posStartRef.current.y + dy,
    });
  };

  const handleMouseUp = () => setDragging(false);

  return (
    <div
      className={`fixed inset-0 z-50 flex touch-none select-none items-center justify-center bg-black/80 transition-opacity duration-150 ${
        isMounted && !isClosing ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ 
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        touchAction: 'none',
        willChange: 'opacity'
      }}
      onWheel={handleWheel}
      onTouchMove={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Close */}
      <button
        onClick={handleClose}
        className={`absolute top-4 right-4 w-9 h-9 rounded-full bg-black/40 text-white/70 hover:text-white hover:bg-black/60 flex items-center justify-center transition-all duration-150 z-10 ${
          isMounted && !isClosing ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
        }`}
        style={{ willChange: 'opacity, transform' }}
      >
        <X className="w-5 h-5" />
      </button>

      {/* Navigation arrows */}
      {isMultiple && (
        <>
          <button
            onClick={prevImage}
            disabled={currentIndex === 0}
            className={`absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 text-white/70 hover:text-white hover:bg-black/60 flex items-center justify-center transition-all duration-150 z-10 disabled:opacity-30 disabled:cursor-not-allowed ${
              isMounted && !isClosing ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-4'
            }`}
            style={{ willChange: 'opacity, transform' }}
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={nextImage}
            disabled={currentIndex === images.length - 1}
            className={`absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 text-white/70 hover:text-white hover:bg-black/60 flex items-center justify-center transition-all duration-150 z-10 disabled:opacity-30 disabled:cursor-not-allowed ${
              isMounted && !isClosing ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
            }`}
            style={{ willChange: 'opacity, transform' }}
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}

      {/* Image counter */}
      {isMultiple && (
        <div className={`absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 rounded-full px-4 py-1.5 z-10 transition-all duration-150 ${
          isMounted && !isClosing ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
        }`}
        style={{ willChange: 'opacity, transform' }}>
          <span className="text-white/80 text-sm tabular-nums">{currentIndex + 1} / {images.length}</span>
        </div>
      )}

      {/* Toolbar */}
      <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 rounded-full px-2 py-1.5 z-10 transition-all duration-150 ${
        isMounted && !isClosing ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      }`}
      style={{ willChange: 'opacity, transform' }}>
        <button onClick={zoomOut} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="缩小">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>
        </button>
        <span className="text-white/80 text-xs min-w-[44px] text-center tabular-nums">{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="放大">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>
        </button>
        <div className="w-px h-4 bg-white/20 mx-1" />
        <button onClick={resetView} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="重置视图">
          <Maximize2 className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-white/20 mx-1" />
        <button onClick={() => void runImageAction('download', currentPayload)} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="下载">
          <Download className="w-4 h-4" />
        </button>
        <button onClick={() => void runImageAction('copy', currentPayload)} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="复制图片">
          <Copy className="w-4 h-4" />
        </button>
        <button onClick={() => void runImageAction('add-to-assets', currentPayload)} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="添加到素材库">
          <ImagePlus className="w-4 h-4" />
        </button>
        <button onClick={() => void runImageAction('use-as-reference', currentPayload)} className="w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="作为图生图参考">
          <Wand2 className="w-4 h-4" />
        </button>
      </div>

      {/* Image container */}
      <div
        className={`h-screen w-screen touch-none overflow-hidden transition-all duration-150 ${
          isMounted && !isClosing ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragging ? 'grabbing' : 'grab', willChange: 'transform, opacity' }}
      >
        <img
          src={currentSrc}
          alt={title}
          draggable={false}
          className="w-screen h-screen object-contain origin-center transition-transform duration-75"
          style={{ transform: `scale(${scale}) translate(${pos.x / scale}px, ${pos.y / scale}px)` }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}
