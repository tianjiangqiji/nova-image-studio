'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Clipboard, Copy, Download, ImagePlus, Maximize, RefreshCw, RotateCcw, Thermometer, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button, buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useImageLazyLoad } from '@/hooks/useImageLazyLoad';
import { getImageSrc, type StoredJob } from '@/lib/job-store';
import { resolveStoredImageRef, revokeBlobUrls } from '@/lib/image-downloader';
import { getModelDisplayName, getOutputSizeLabel } from '@/lib/model-capabilities';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import {
  copyImagePayload,
  dispatchImageActionToast,
  runImageAction,
  type ImageActionPayload,
} from '@/lib/image-actions';

interface CompletedJobCardProps {
  job: StoredJob;
  onClear: () => void;
  onRetry: (job: StoredJob) => void;
  onRetryDownload?: (job: StoredJob) => void | Promise<void>;
}

interface DownloadProgressSummary {
  active: boolean;
  failed: number;
  message: string;
  percent: number;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getDownloadProgressSummary(progress: StoredJob['imageDownloadProgress']): DownloadProgressSummary | null {
  if (!progress || progress.total <= 0) return null;

  const active = progress.items.some(item => item.status === 'pending' || item.status === 'downloading');
  const failed = progress.failed;
  if (!active && failed === 0) return null;

  const loadedBytes = progress.items.reduce((sum, item) => sum + (item.loadedBytes || 0), 0);
  const knownTotalBytes = progress.items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  const bytePercent = knownTotalBytes > 0
    ? Math.min(100, Math.round((loadedBytes / knownTotalBytes) * 100))
    : undefined;
  const completionPercent = Math.min(
    100,
    Math.round(((progress.completed + progress.failed) / progress.total) * 100)
  );
  const percent = bytePercent ?? completionPercent;
  const message = active
    ? knownTotalBytes > 0
      ? `正在取回 ${formatBytes(loadedBytes)} / ${formatBytes(knownTotalBytes)}，${percent}%`
      : `正在取回 ${formatBytes(loadedBytes)}`
    : `取回失败 ${failed} 张，已缓存 ${progress.completed} 张`;

  return {
    active,
    failed,
    message,
    percent,
  };
}

export const CompletedJobCard = memo(function CompletedJobCard({ job, onClear, onRetry, onRetryDownload }: CompletedJobCardProps) {
  const [imgCopied, setImgCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [retryingDownload, setRetryingDownload] = useState(false);

  const sourceImages = useMemo(() => job.images || (job.imageData ? [job.imageData] : []), [job.imageData, job.images]);
  const [images, setImages] = useState(sourceImages);
  const resolvedBlobUrlsRef = useRef<string[]>([]);
  const actionPayloads = useMemo<ImageActionPayload[]>(() => sourceImages.map((imageRef, index) => ({
    id: `${job.id}-${index}`,
    name: `nova-image-${job.id.slice(0, 8)}${sourceImages.length > 1 ? `-${index + 1}` : ''}`,
    storedRef: { jobId: job.id, imageRef, imageIndex: index },
    sourceKind: job.mode === 'image-to-image' ? 'image-to-image' : 'text-to-image',
    sourceLabel: job.mode === 'image-to-image' ? '图生图历史结果' : '文生图历史结果',
    sourceRef: `${job.id}:${index}`,
    prompt: job.prompt,
  })), [job.id, job.mode, job.prompt, sourceImages]);

  /** 是否存在仍以远程 URL 形式呈现的图片（即首次本地缓存失败、需要"重新下载"补齐）。 */
  const needsRedownload = useMemo(
    () => sourceImages.some(img => img.startsWith('URL:') || img.startsWith('MULTI_URL:')),
    [sourceImages]
  );
  const downloadProgressSummary = useMemo(
    () => getDownloadProgressSummary(job.imageDownloadProgress),
    [job.imageDownloadProgress]
  );
  const isDownloadingImages = !!downloadProgressSummary?.active;

  const handleRetryDownload = useCallback(async () => {
    if (!onRetryDownload || retryingDownload || isDownloadingImages) return;
    setRetryingDownload(true);
    try {
      await onRetryDownload(job);
    } finally {
      setRetryingDownload(false);
    }
  }, [isDownloadingImages, job, onRetryDownload, retryingDownload]);

  const revokeResolvedBlobUrls = useCallback(() => {
    if (resolvedBlobUrlsRef.current.length > 0) {
      revokeBlobUrls(resolvedBlobUrlsRef.current);
      resolvedBlobUrlsRef.current = [];
    }
  }, []);

  useEffect(() => {
    setImages(sourceImages);
    return revokeResolvedBlobUrls;
  }, [revokeResolvedBlobUrls, sourceImages]);

  useEffect(() => {
    const urls = job.blobUrls;
    return () => {
      if (urls) {
        revokeBlobUrls(urls);
      }
    };
  }, [job.blobUrls]);

  const resolveImageAt = useCallback(async (index: number): Promise<string | undefined> => {
    const image = images[index] || sourceImages[index];
    if (!image) return undefined;
    if (image.startsWith('blob:') && image !== sourceImages[index]) return image;
    if (!image.startsWith('IDB:') && !image.startsWith('blob:')) return image;

    const resolved = await resolveStoredImageRef(job.id, image, index);
    if (resolved.blobUrl) {
      resolvedBlobUrlsRef.current.push(resolved.blobUrl);
      setImages(prev => prev.map((item, itemIndex) => (itemIndex === index ? resolved.image : item)));
    }

    return resolved.image;
  }, [images, job.id, sourceImages]);

  const resolveImagesAt = useCallback(async (indexes: number[]): Promise<string[]> => {
    const resolved = await Promise.all(indexes.map(index => resolveImageAt(index)));
    return resolved.filter((image): image is string => !!image);
  }, [resolveImageAt]);

  const visiblePreviewImages = images.slice(0, 3);
  const isMultiple = sourceImages.length > 1;
  const supportsTemperature = !job.model.startsWith('gpt-image-2');
  const outputSizeLabel = job.custom_size || getOutputSizeLabel(job.output_size);
  const lazyLoad = useImageLazyLoad<HTMLDivElement>({
    rootMargin: '300px',
    enabled: true,
  });
  // 单独跟踪每个可见缩略图的加载状态，避免单图失败导致全部不显示
  const [loadedImageIndices, setLoadedImageIndices] = useState<Set<number>>(new Set());
  const handleImageLoad = useCallback((index: number) => {
    setLoadedImageIndices(prev => new Set(prev).add(index));
    // 第一张图加载完成时同步更新lazyLoad状态
    if (index === 0) {
      lazyLoad.handleImageLoad();
    }
  }, [lazyLoad]);

  const downloadImage = (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    void runImageAction('download', payload);
  };

  const addImageToAssets = (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    void runImageAction('add-to-assets', payload);
  };

  const addAllToAssets = () => {
    actionPayloads.forEach((_, index) => {
      setTimeout(() => addImageToAssets(index), index * 100);
    });
    setAssetMenuOpen(false);
  };

  const downloadAll = () => {
    actionPayloads.forEach((_, index) => {
      setTimeout(() => downloadImage(index), index * 100);
    });
    setDownloadMenuOpen(false);
  };

  const copyImage = async (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    try {
      await copyImagePayload(payload);
      setImgCopied(true);
      setTimeout(() => setImgCopied(false), 2000);
      setCopyMenuOpen(false);
      dispatchImageActionToast('图片已复制', 'success');
    } catch (error) {
      setCopyMenuOpen(false);
      const message = error instanceof Error ? error.message : '图片复制失败';
      dispatchImageActionToast(message.includes('Failed to fetch') ? '该图片源不允许本地保存或复制，请直接右键/长摁复制' : message, 'error');
    }
  };

  const copyPrompt = () => {
    navigator.clipboard.writeText(job.prompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  };

  const openPreview = async () => {
    const resolved = await resolveImagesAt(sourceImages.map((_, index) => index));
    setPreviewImages(resolved.map(getImageSrc).filter(Boolean));
    setPreviewOpen(true);
  };

  useEffect(() => {
    if (!lazyLoad.isVisible) return;
    void resolveImageAt(0);
  }, [lazyLoad.isVisible, resolveImageAt]);

  if (sourceImages.length === 0) {
    return null;
  }

  return (
    <>
      <div className="group relative rounded-xl border border-border bg-card p-4">
        {/* 删除按钮：悬浮在卡片右上角外侧，hover 变红 */}
        <button
          type="button"
          onClick={() => setDeleteDialogOpen(true)}
          title="移除"
          className="absolute -right-2 -top-2 z-20 flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-all hover:border-destructive hover:bg-destructive hover:text-white group-hover:opacity-100"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center gap-3">
          <div
            ref={lazyLoad.elementRef}
            className="group relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-muted"
          >
            <button
              type="button"
              onClick={() => void openPreview()}
              className="absolute inset-0 h-full w-full border-0 p-0"
              title="看大图"
            >
              {isMultiple ? (
                <div className="relative h-full w-full">
                {visiblePreviewImages.map((image, index) => (
                  <img
                    key={`${job.id}-${index}`}
                    src={lazyLoad.isVisible ? (getImageSrc(image) || undefined) : undefined}
                    alt={`生成的图像 ${index + 1}`}
                    className={`absolute h-full w-full object-cover transition-all duration-300 ${
                      loadedImageIndices.has(index) ? 'opacity-100' : 'opacity-0'
                    }`}
                    style={{
                      transform: `rotate(${(index - 1) * 5}deg) translate(${(index - 1) * 2}px, ${(index - 1) * 2}px)`,
                      zIndex: 3 - index,
                    }}
                    onLoad={() => handleImageLoad(index)}
                  />
                ))}
                {!lazyLoad.isLoaded && (
                  <div className="absolute inset-0 z-10 animate-pulse bg-gradient-to-r from-muted via-muted/50 to-muted" />
                )}
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                  <Maximize className="w-5 h-5 text-white" />
                </div>
                </div>
              ) : (
                <>
                <img
                  src={lazyLoad.isVisible ? (getImageSrc(images[0]) || undefined) : undefined}
                  alt="生成的图像"
                  className={`h-full w-full object-cover transition-opacity duration-300 ${lazyLoad.isLoaded ? 'opacity-100' : 'opacity-0'}`}
                  onLoad={lazyLoad.handleImageLoad}
                />
                {!lazyLoad.isLoaded && (
                  <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-muted/50 to-muted" />
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                  <Maximize className="w-5 h-5 text-white" />
                </div>
                </>
              )}
            </button>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-base text-foreground">&quot;{job.prompt}&quot;</p>
              <button
                onClick={copyPrompt}
                className="flex-shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                title="复制提示词"
              >
                {promptCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            {job.warning && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
                <AlertCircle className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{job.warning}</span>
              </p>
            )}

            {downloadProgressSummary && (
              <div
                className="mt-2 flex max-w-56 items-center gap-2"
                title={downloadProgressSummary.message}
                aria-label={downloadProgressSummary.message}
              >
                <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={`h-full transition-all duration-300 ease-out ${downloadProgressSummary.failed > 0 && !downloadProgressSummary.active ? 'bg-warning' : 'bg-primary'}`}
                    style={{ width: `${Math.max(4, downloadProgressSummary.percent)}%` }}
                  />
                </div>
                <span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {downloadProgressSummary.percent}%
                </span>
              </div>
            )}

            {/* 元信息：第一行 模型ID + 温度 + 数量；第二行 分辨率 + 比例 */}
            <div className="mt-0.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span className="shrink-0">{getModelDisplayName(job.model)}</span>
                {supportsTemperature && (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Thermometer className="w-3 h-3" />
                    {job.temperature?.toFixed(2) ?? 1}
                  </span>
                )}
                {isMultiple && (
                  <span className="shrink-0 font-medium text-primary">
                    x{sourceImages.length}{job.parallelCount && job.parallelCount > sourceImages.length ? `/${job.parallelCount}` : ''}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span>{outputSizeLabel}</span>
                {job.aspect_ratio !== '1:1' && job.aspect_ratio !== 'auto' && <><span>·</span><span>{job.aspect_ratio}</span></>}
              </div>
            </div>
          </div>

          {/* 工具按钮双行布局 */}
          <div className="flex flex-shrink-0 flex-col items-center gap-1">
            <div className="flex items-center gap-1">
              {needsRedownload && onRetryDownload && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void handleRetryDownload()}
                  disabled={retryingDownload || isDownloadingImages}
                  title={isDownloadingImages ? '正在取回图片' : '重新下载到本地缓存'}
                  className="text-warning hover:text-warning/80"
                >
                  <RefreshCw className={`w-4 h-4 ${retryingDownload || isDownloadingImages ? 'animate-spin' : ''}`} />
                </Button>
              )}

              {isMultiple ? (
                <DropdownMenu open={assetMenuOpen} onOpenChange={setAssetMenuOpen}>
                  <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="添加到素材库">
                    <ImagePlus className="w-4 h-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {sourceImages.map((_, index) => (
                      <DropdownMenuItem key={index} onClick={() => {
                        addImageToAssets(index);
                        setAssetMenuOpen(false);
                      }}>
                        保存图片 {index + 1}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={addAllToAssets} className="font-medium text-primary">
                      <ImagePlus className="mr-1.5 w-3.5 h-3.5" />
                      保存全部
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => addImageToAssets(0)}
                  title="添加到素材库"
                >
                  <ImagePlus className="w-4 h-4" />
                </Button>
              )}

              {isMultiple ? (
                <DropdownMenu open={downloadMenuOpen} onOpenChange={setDownloadMenuOpen}>
                  <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="下载">
                    <Download className="w-4 h-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {sourceImages.map((_, index) => (
                      <DropdownMenuItem key={index} onClick={() => {
                        downloadImage(index);
                        setDownloadMenuOpen(false);
                      }}>
                        下载图片 {index + 1}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={downloadAll} className="font-medium text-primary">
                      <Download className="mr-1.5 w-3.5 h-3.5" />
                      下载全部
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button variant="ghost" size="icon-sm" onClick={() => downloadImage(0)} title="下载">
                  <Download className="w-4 h-4" />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-1">
              {isMultiple ? (
                <DropdownMenu open={copyMenuOpen} onOpenChange={setCopyMenuOpen}>
                  <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="复制图片">
                    {imgCopied ? <Check className="w-4 h-4 text-success" /> : <Clipboard className="w-4 h-4" />}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {sourceImages.map((_, index) => (
                      <DropdownMenuItem key={index} onClick={() => copyImage(index)}>
                        复制图片 {index + 1}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button variant="ghost" size="icon-sm" onClick={() => copyImage(0)} title="复制图片">
                  {imgCopied ? <Check className="w-4 h-4 text-success" /> : <Clipboard className="w-4 h-4" />}
                </Button>
              )}

              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onRetry(job)}
                title="重试"
              >
                <RotateCcw className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {previewOpen && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt={job.prompt}
          onClose={() => setPreviewOpen(false)}
          actionPayloads={actionPayloads}
        />,
        document.body
      )}

      {deleteDialogOpen && createPortal(
        <ConfirmDialog
          title="删除记录"
          message={
            <>
              确定要删除这条记录吗？此操作无法撤销。
              {isMultiple && <span className="mt-1 block text-warning">这将删除 {sourceImages.length} 张图片。</span>}
            </>
          }
          confirmText="删除"
          onConfirm={onClear}
          onCancel={() => setDeleteDialogOpen(false)}
        />,
        document.body
      )}
    </>
  );
});
