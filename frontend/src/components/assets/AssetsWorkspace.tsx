'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FileArchive,
  FileText,
  Grid3X3,
  HardDrive,
  ImageIcon,
  ImagePlus,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { useImageLazyLoad } from '@/hooks/useImageLazyLoad';
import {
  addImageAsset,
  addTextAsset,
  deleteAsset,
  formatAssetSize,
  getAssetBlob,
  getAssetThumbnailBlob,
  getSourceKindLabel,
  listAssets,
  updateImageAsset,
  type AssetItem,
  type AssetSourceKind,
  type ImageAsset,
  type TextAsset,
} from '@/lib/asset-store';
import { generateAssetMetadata, type AssetMetadataSuggestion } from '@/lib/asset-metadata-client';
import { dispatchImageActionToast, runImageAction, type ImageActionPayload } from '@/lib/image-actions';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { prepareUploadImage } from '@/lib/upload-image-cache';
import { cn } from '@/lib/utils';

interface AssetsWorkspaceProps {
  wideMode?: boolean;
  active?: boolean;
}

const SETTINGS_KEY = 'nova-assets-settings';
const PAGE_SIZE = 48;
const PROMPT_TAG = '提示词';
const SORT_OPTIONS: Array<{ value: 'newest' | 'oldest' | 'used'; label: string }> = [
  { value: 'newest', label: '最新添加' },
  { value: 'oldest', label: '最早添加' },
  { value: 'used', label: '最近使用' },
];
const VIEW_SIZE_OPTIONS: Array<{ value: AssetViewSize; label: string }> = [
  { value: 'compact', label: '小' },
  { value: 'normal', label: '大' },
  { value: 'large', label: '详细' },
];
type AssetViewSize = 'compact' | 'normal' | 'large';
type AssetSettings = { sort: 'newest' | 'oldest' | 'used'; viewSize: AssetViewSize };

export function loadAssetSettings(): AssetSettings {
  if (typeof window === 'undefined') return { sort: 'newest', viewSize: 'normal' };
  const saved = loadJsonFromStorage<AssetSettings>(SETTINGS_KEY);
  return {
    sort: saved.sort === 'oldest' || saved.sort === 'used' ? saved.sort : 'newest',
    viewSize: saved.viewSize === 'compact' || saved.viewSize === 'large' ? saved.viewSize : 'normal',
  };
}

function splitTags(input: string): string[] {
  return input.split(/[,\s，、]+/).map(tag => tag.trim()).filter(Boolean);
}

function isTextAsset(asset: AssetItem): asset is TextAsset {
  return asset.kind === 'text';
}

function isImageAsset(asset: AssetItem): asset is ImageAsset {
  return asset.kind !== 'text';
}

function uniqueTags(assets: AssetItem[]): string[] {
  const tags = new Set<string>();
  let hasTextAsset = false;
  for (const asset of assets) {
    if (isTextAsset(asset)) {
      hasTextAsset = true;
      continue;
    }
    for (const tag of asset.tags) tags.add(tag);
  }
  const imageTags = Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return hasTextAsset ? [PROMPT_TAG, ...imageTags.filter(tag => tag !== PROMPT_TAG)] : imageTags;
}

function makePayload(asset: ImageAsset): ImageActionPayload {
  return {
    id: asset.id,
    name: asset.name,
    assetId: asset.id,
    mimeType: asset.mimeType,
    sourceKind: asset.sourceKind,
    sourceLabel: asset.sourceLabel,
    sourceRef: asset.sourceRef || asset.id,
    prompt: asset.prompt,
    note: asset.note,
  };
}

function getZipEntryName(asset: ImageAsset): string {
  const safeName = (asset.name || asset.id).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || asset.id;
  const ext = asset.mimeType.includes('jpeg') ? 'jpg' : asset.mimeType.split('/')[1] || 'png';
  return safeName.toLowerCase().endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`;
}

async function prepareAssetMetadataImage(asset: ImageAsset, blob: Blob): Promise<string> {
  const prepared = await prepareUploadImage(new File([blob], getZipEntryName(asset), { type: asset.mimeType || blob.type || 'image/png' }));
  return prepared.dataUrl;
}

function getTextEntryName(asset: TextAsset): string {
  const content = asset.content.trim().split(/\s+/).join('-').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  return `${content || asset.id}.txt`;
}

function matchesAsset(asset: AssetItem, query: string, tag: string, source: string): boolean {
  if (tag === PROMPT_TAG && !isTextAsset(asset)) return false;
  if (tag && tag !== PROMPT_TAG && (!isImageAsset(asset) || !asset.tags.includes(tag))) return false;
  if (source && asset.sourceKind !== source) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (isTextAsset(asset)) {
    return [
      asset.content,
      asset.sourceLabel,
      asset.sourceRef || '',
    ].some(value => value.toLowerCase().includes(q));
  }
  return [
    asset.name,
    asset.note,
    asset.sourceLabel,
    asset.sourceRef || '',
    asset.prompt || '',
    asset.tags.join(' '),
  ].some(value => value.toLowerCase().includes(q));
}

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function StorageEstimate({ totalBytes }: { totalBytes: number }) {
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then(value => {
        if (!cancelled) setEstimate({ usage: value.usage, quota: value.quota });
      });
    }
    return () => { cancelled = true; };
  }, [totalBytes]);

  const usage = estimate?.usage;
  const quota = estimate?.quota;
  const lowSpace = typeof usage === 'number' && typeof quota === 'number' && quota > 0
    && (usage / quota >= 0.9 || quota - usage <= 250 * 1024 * 1024);
  const browserUsage = usage && quota
    ? ` · 浏览器 ${(usage / 1024 / 1024).toFixed(0)} / ${(quota / 1024 / 1024).toFixed(0)} MB`
    : '';

  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', lowSpace ? 'text-warning' : 'text-muted-foreground')}>
      <HardDrive className="h-3.5 w-3.5" />
      素材 {formatAssetSize(totalBytes)}{browserUsage}
      {lowSpace && <span className="font-medium"> · 空间偏紧，请清理素材</span>}
    </span>
  );
}

function AssetThumbnail({
  asset,
  viewSize,
  onPreview,
}: {
  asset: ImageAsset;
  viewSize: AssetViewSize;
  onPreview: () => void;
}) {
  const lazyLoad = useImageLazyLoad<HTMLButtonElement>({ rootMargin: '300px' });
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!lazyLoad.isVisible) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    void getAssetThumbnailBlob(asset).then(blob => {
      if (!blob || cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setThumbUrl(objectUrl);
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, lazyLoad.isVisible]);

  const { elementRef, isLoaded, handleImageLoad } = lazyLoad;

  return (
    <button
      ref={elementRef}
      type="button"
      onClick={onPreview}
      className="relative block aspect-square w-full overflow-hidden bg-muted"
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt={asset.name}
          className="h-full w-full object-cover transition-opacity"
          loading="lazy"
          onLoad={handleImageLoad}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className={cn('opacity-50', viewSize === 'compact' ? 'h-5 w-5' : 'h-7 w-7')} />
        </div>
      )}
      {!isLoaded && thumbUrl && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-muted/50 to-muted" />
      )}
    </button>
  );
}

export function AssetsWorkspace({ wideMode = false, active = true }: AssetsWorkspaceProps) {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 180);
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sort, setSort] = useState<'newest' | 'oldest' | 'used'>(() => loadAssetSettings().sort);
  const [viewSize, setViewSize] = useState<AssetViewSize>(() => loadAssetSettings().viewSize);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [editingAsset, setEditingAsset] = useState<ImageAsset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetItem | null>(null);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [packing, setPacking] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const [metadataGenerating, setMetadataGenerating] = useState(false);
  const [metadataSuggestion, setMetadataSuggestion] = useState<AssetMetadataSuggestion | null>(null);
  const [editName, setEditName] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editNote, setEditNote] = useState('');
  const [textDialogOpen, setTextDialogOpen] = useState(false);
  const [textContent, setTextContent] = useState('');
  const fullObjectUrlsRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tagDragRef = useRef({ pointerId: -1, startX: 0, scrollLeft: 0, dragged: false });

  const revokeFullObjectUrls = useCallback(() => {
    for (const url of fullObjectUrlsRef.current) URL.revokeObjectURL(url);
    fullObjectUrlsRef.current = [];
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const nextAssets = await listAssets();
    setAssets(nextAssets);
    setLoading(false);
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  useEffect(() => {
    saveJsonToStorage(SETTINGS_KEY, { sort, viewSize });
  }, [sort, viewSize]);

  const filteredAssets = useMemo(() => {
    const filtered = assets.filter(asset => matchesAsset(asset, debouncedQuery, selectedTag, selectedSource));
    if (sort === 'oldest') {
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    }
    if (sort === 'used') {
      return filtered.sort((a, b) => (b.lastUsedAt || b.updatedAt || b.createdAt) - (a.lastUsedAt || a.updatedAt || a.createdAt));
    }
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }, [assets, debouncedQuery, selectedSource, selectedTag, sort]);

  const visibleAssets = useMemo(() => filteredAssets.slice(0, visibleCount), [filteredAssets, visibleCount]);
  useEffect(() => {
    if (!active) return;
    setPreviewIndex(null);
    revokeFullObjectUrls();
    setPreviewImages([]);
  }, [active, revokeFullObjectUrls, visibleAssets]);

  useEffect(() => {
    if (!active) {
      revokeFullObjectUrls();
      setPreviewImages([]);
      setPreviewIndex(null);
    }
  }, [active, revokeFullObjectUrls]);

  useEffect(() => () => revokeFullObjectUrls(), [revokeFullObjectUrls]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [debouncedQuery, selectedSource, selectedTag, sort]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const allTags = useMemo(() => uniqueTags(assets), [assets]);
  const sources = useMemo<AssetSourceKind[]>(() => Array.from(new Set(assets.map(asset => asset.sourceKind))).sort(), [assets]);
  const totalBytes = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const asset of assets) {
      if (isImageAsset(asset)) {
        if (seen.has(asset.blobKey)) continue;
        seen.add(asset.blobKey);
      }
      total += asset.sizeBytes || 0;
    }
    return total;
  }, [assets]);
  const selectedCount = selectedAssetIds.size;
  const allVisibleSelected = visibleAssets.length > 0 && visibleAssets.every(asset => selectedAssetIds.has(asset.id));
  const selectedSourceLabel = selectedSource ? getSourceKindLabel(selectedSource as AssetSourceKind) : '全部来源';
  const sortLabel = SORT_OPTIONS.find(option => option.value === sort)?.label || '最新添加';

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSelectedAssetIds(prev => {
      const validIds = new Set(assets.map(asset => asset.id));
      const next = new Set(Array.from(prev).filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [assets]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const openPreview = useCallback(async (assetId: string) => {
    revokeFullObjectUrls();
    const imageAssets = visibleAssets.filter(isImageAsset);
    const urls = await Promise.all(imageAssets.map(async asset => {
      const blob = await getAssetBlob(asset.id);
      if (!blob) return '';
      const url = URL.createObjectURL(blob);
      fullObjectUrlsRef.current.push(url);
      return url;
    }));
    setPreviewImages(urls);
    setPreviewIndex(Math.max(0, imageAssets.findIndex(asset => asset.id === assetId)));
  }, [revokeFullObjectUrls, visibleAssets]);

  const closePreview = useCallback(() => {
    setPreviewIndex(null);
    revokeFullObjectUrls();
    setPreviewImages([]);
  }, [revokeFullObjectUrls]);

  const handleImportFiles = useCallback(async (files: FileList | File[]) => {
    const images = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (images.length === 0) {
      dispatchImageActionToast('请选择图片文件', 'error');
      return;
    }
    setImporting(true);
    try {
      let imported = 0;
      for (const file of images) {
        await addImageAsset({
          blob: file,
          name: file.name,
          sourceKind: 'manual',
          sourceLabel: '手动导入',
          sourceRef: file.name,
        });
        imported++;
      }
      await reload();
      dispatchImageActionToast(`已导入 ${imported} 张图片`, 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '导入素材失败', 'error');
    } finally {
      setImporting(false);
    }
  }, [reload]);

  const saveTextAsset = useCallback(async () => {
    try {
      await addTextAsset({
        content: textContent,
        sourceKind: 'manual',
        sourceLabel: '手动导入',
      });
      setTextContent('');
      setTextDialogOpen(false);
      await reload();
      dispatchImageActionToast('提示词素材已保存', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  }, [reload, textContent]);

  const openEdit = useCallback((asset: ImageAsset) => {
    setEditingAsset(asset);
    setEditName(asset.name);
    setEditTags(asset.tags.join(' '));
    setEditNote(asset.note);
    setMetadataSuggestion(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingAsset || metadataGenerating) return;
    try {
      await updateImageAsset(editingAsset.id, {
        name: editName,
        tags: splitTags(editTags),
        note: editNote,
      });
      setEditingAsset(null);
      await reload();
      dispatchImageActionToast('素材已更新', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '更新素材失败', 'error');
    }
  }, [editName, editNote, editTags, editingAsset, metadataGenerating, reload]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteAsset(deleteTarget.id);
      setDeleteTarget(null);
      await reload();
      dispatchImageActionToast('素材已删除', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '删除素材失败', 'error');
    }
  }, [deleteTarget, reload]);

  const confirmDeleteSelected = useCallback(async () => {
    if (selectedAssetIds.size === 0 || bulkDeleting) return;
    setBulkDeleting(true);
    try {
      const idsToDelete = new Set(selectedAssetIds);
      let deletedCount = 0;
      for (const asset of assets) {
        if (!idsToDelete.has(asset.id)) continue;
        await deleteAsset(asset.id);
        deletedCount++;
      }
      setDeleteSelectedOpen(false);
      setSelectedAssetIds(prev => {
        const next = new Set(prev);
        for (const id of idsToDelete) next.delete(id);
        return next;
      });
      await reload();
      dispatchImageActionToast(`已删除 ${deletedCount} 项素材`, 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '删除选中素材失败', 'error');
    } finally {
      setBulkDeleting(false);
    }
  }, [assets, bulkDeleting, reload, selectedAssetIds]);

  const toggleAssetSelection = useCallback((assetId: string) => {
    setSelectedAssetIds(prev => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }, []);

  const toggleSelectVisible = useCallback(() => {
    setSelectedAssetIds(prev => {
      if (visibleAssets.length === 0) return prev;
      const next = new Set(prev);
      const shouldClear = visibleAssets.every(asset => next.has(asset.id));
      for (const asset of visibleAssets) {
        if (shouldClear) next.delete(asset.id);
        else next.add(asset.id);
      }
      return next;
    });
  }, [visibleAssets]);

  const downloadSelectedAssets = useCallback(async () => {
    if (selectedAssetIds.size === 0 || packing) return;
    setPacking(true);
    try {
      const zip = new JSZip();
      let readme = '我的素材导出\n\n';
      let count = 0;
      for (const asset of assets.filter(item => selectedAssetIds.has(item.id))) {
        if (isTextAsset(asset)) {
          zip.file(getTextEntryName(asset), asset.content);
          count++;
          continue;
        }
        const blob = await getAssetBlob(asset.id);
        if (!blob) continue;
        const fileName = getZipEntryName(asset);
        zip.file(fileName, blob);
        readme += `${fileName}\n`;
        readme += `  名称: ${asset.name}\n`;
        readme += `  来源: ${asset.sourceLabel}\n`;
        readme += `  标签: ${asset.tags.join('、') || '(无)'}\n`;
        readme += `  备注: ${asset.note || '(无)'}\n\n`;
        count++;
      }
      if (count === 0) throw new Error('没有可导出的素材');
      zip.file('README.txt', readme);
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `nova-assets-${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      dispatchImageActionToast(`已打包 ${count} 项素材`, 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '打包下载失败', 'error');
    } finally {
      setPacking(false);
    }
  }, [assets, packing, selectedAssetIds]);

  const generateEditMetadata = useCallback(async () => {
    if (!editingAsset || metadataGenerating) return;
    let textModel;
    try {
      textModel = requireDefaultConfiguredTextModel('imageDescribe');
    } catch {
      dispatchImageActionToast('请先在设置中完成图片描述默认文本模型配置', 'error');
      return;
    }
    setMetadataGenerating(true);
    setMetadataSuggestion(null);
    try {
      const blob = await getAssetBlob(editingAsset.id);
      if (!blob) throw new Error('无法读取素材图片');
      const imageDataUrl = await prepareAssetMetadataImage(editingAsset, blob);
      const suggestion = await generateAssetMetadata({
        apiKey: textModel.apiKey,
        baseUrl: textModel.baseUrl,
        model: textModel.id,
        imageDataUrl,
        currentName: editName,
        currentTags: splitTags(editTags),
        currentNote: editNote,
      });
      setMetadataSuggestion(suggestion);
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '生成素材信息失败', 'error');
    } finally {
      setMetadataGenerating(false);
    }
  }, [editName, editNote, editTags, editingAsset, metadataGenerating]);

  const applyMetadataSuggestion = useCallback(() => {
    if (!metadataSuggestion || metadataGenerating) return;
    setEditName(metadataSuggestion.name);
    setEditTags(metadataSuggestion.tags.join(' '));
    setEditNote(metadataSuggestion.note);
    setMetadataSuggestion(null);
  }, [metadataGenerating, metadataSuggestion]);

  return (
    <section className={cn('min-w-0 space-y-4 overflow-hidden', wideMode && 'xl:flex xl:h-full xl:min-h-0 xl:flex-col')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-medium text-foreground">我的素材</h3>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted-foreground">共 {assets.length} 项 · 当前 {filteredAssets.length} 项</p>
            <StorageEstimate totalBytes={totalBytes} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteSelectedOpen(true)}
            disabled={selectedCount === 0 || bulkDeleting}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            {bulkDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {selectedCount > 0 ? `删除 (${selectedCount})` : '删除'}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void downloadSelectedAssets()}
            disabled={selectedCount === 0 || packing}
            className="gap-1.5"
          >
            {packing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileArchive className="h-3.5 w-3.5" />}
            {selectedCount > 0 ? `打包下载 (${selectedCount})` : '打包下载'}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={event => {
              if (event.target.files) void handleImportFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={importing} className="gap-1.5">
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            导入图片
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTextDialogOpen(true)} className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            新建提示词
          </Button>
        </div>
      </div>

      <div className="min-w-0 space-y-3 overflow-hidden rounded-xl border border-border bg-card p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索名称、标签、备注、来源、提示词"
              className="pl-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="清空搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Popover open={sourcePopoverOpen} onOpenChange={setSourcePopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="justify-between gap-2">
                来源：{selectedSourceLabel}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-2">
              <div className="space-y-1">
                {[{ value: '', label: '全部来源' }, ...sources.map(source => ({ value: source, label: getSourceKindLabel(source) }))].map(option => (
                  <button
                    key={option.value || 'all'}
                    type="button"
                    onClick={() => {
                      setSelectedSource(option.value);
                      setSourcePopoverOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      selectedSource === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                    )}
                  >
                    {option.label}
                    {selectedSource === option.value && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="justify-between gap-2">
                排序：{sortLabel}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-2">
              <div className="space-y-1">
                {SORT_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setSort(option.value);
                      setSortPopoverOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      sort === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                    )}
                  >
                    {option.label}
                    {sort === option.value && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <div className="flex h-7 items-center rounded-lg border border-border bg-background p-0.5">
            {VIEW_SIZE_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => setViewSize(option.value)}
                className={cn(
                  'flex h-6 min-w-7 items-center justify-center rounded-md px-2 text-xs transition-colors',
                  viewSize === option.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                title={`展示区域：${option.label}`}
              >
                <Grid3X3 className="mr-1 h-3 w-3" />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {allTags.length > 0 && (
          <div
            className="flex gap-1.5 overflow-x-auto touch-pan-x select-none overscroll-x-contain [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: 'none' }}
            onPointerDown={event => {
              const el = event.currentTarget;
              if (!el || (event.pointerType === 'mouse' && event.button !== 0) || el.scrollWidth <= el.clientWidth) return;
              tagDragRef.current = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: el.scrollLeft, dragged: false };
            }}
            onPointerMove={event => {
              const el = event.currentTarget;
              const state = tagDragRef.current;
              if (state.pointerId !== event.pointerId) return;
              const deltaX = event.clientX - state.startX;
              if (Math.abs(deltaX) > 4) state.dragged = true;
              if (state.dragged) { el.scrollLeft = state.scrollLeft - deltaX; event.preventDefault(); }
            }}
            onPointerUp={() => {
              tagDragRef.current.pointerId = -1;
            }}
            onPointerLeave={() => {
              tagDragRef.current.pointerId = -1;
              tagDragRef.current.dragged = false;
            }}
            onClickCapture={event => {
              if (!tagDragRef.current.dragged) return;
              event.preventDefault();
              event.stopPropagation();
              tagDragRef.current.dragged = false;
            }}
          >
            <button
              type="button"
              onClick={() => setSelectedTag('')}
              className={cn('inline-flex min-h-7 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 text-xs leading-tight transition-colors', !selectedTag ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted')}
            >
              全部
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => setSelectedTag(tag)}
                className={cn('inline-flex min-h-7 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 text-xs leading-tight transition-colors', selectedTag === tag ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted')}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {visibleAssets.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={toggleSelectVisible} className="gap-1.5">
            <Check className="h-3.5 w-3.5" />
            {allVisibleSelected ? '取消选择当前页' : '选择当前页'}
          </Button>
          <span className="text-xs text-muted-foreground">
            已选择 {selectedCount} 项
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-60 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : visibleAssets.length === 0 ? (
        <div className="flex min-h-72 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center text-muted-foreground">
          <ImageIcon className="h-8 w-8 opacity-60" />
          <p className="text-sm">{assets.length === 0 ? '暂无素材' : '没有匹配的素材'}</p>
          <p className="text-xs">可从生成结果、本地图片或手动新建提示词添加素材。</p>
        </div>
      ) : (
        <div className={cn(
          'grid items-start gap-3',
          viewSize === 'compact' && 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6',
          viewSize === 'normal' && 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
          viewSize === 'large' && 'grid-cols-2 sm:grid-cols-1 lg:grid-cols-2',
          wideMode && viewSize === 'compact' && 'xl:min-h-0 xl:flex-1 xl:auto-rows-max xl:items-start xl:overflow-y-auto xl:pr-1 2xl:grid-cols-8',
          wideMode && viewSize === 'normal' && 'xl:min-h-0 xl:flex-1 xl:auto-rows-max xl:items-start xl:overflow-y-auto xl:pr-1 2xl:grid-cols-5',
          wideMode && viewSize === 'large' && 'xl:min-h-0 xl:flex-1 xl:auto-rows-max xl:items-start xl:overflow-y-auto xl:pr-1 2xl:grid-cols-3'
        )}>
          {visibleAssets.map((asset) => {
            const selected = selectedAssetIds.has(asset.id);
            if (isTextAsset(asset)) {
              return (
                <div
                  key={asset.id}
                  className={cn(
                    'relative flex min-h-36 flex-col overflow-hidden rounded-lg border bg-card p-3 transition-colors hover:border-muted-foreground/40',
                    selected ? 'border-primary ring-1 ring-primary/30' : 'border-border'
                  )}
                >
                  <label className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/55 text-white shadow-sm">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleAssetSelection(asset.id)}
                      className="h-3.5 w-3.5 cursor-pointer accent-primary"
                      title="选择素材"
                    />
                  </label>
                  <p className={cn(
                    'min-h-0 whitespace-pre-wrap leading-relaxed text-foreground',
                    viewSize === 'compact' ? 'line-clamp-5 pl-6 text-xs' : 'line-clamp-8 pl-7 text-sm'
                  )}>
                    {asset.content}
                  </p>
                  <div className="mt-auto flex justify-end gap-1 pt-2">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        void navigator.clipboard?.writeText(asset.content);
                        dispatchImageActionToast('提示词已复制', 'success');
                      }}
                      title="复制提示词"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => setDeleteTarget(asset)} title="删除" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              );
            }
            const payload = makePayload(asset);
            return (
              <div
                key={asset.id}
                className={cn(
                  'relative overflow-hidden rounded-lg border bg-card transition-colors hover:border-muted-foreground/40',
                  viewSize === 'large' && 'sm:flex sm:min-h-44',
                  selected ? 'border-primary ring-1 ring-primary/30' : 'border-border'
                )}
              >
                <label className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/55 text-white shadow-sm">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleAssetSelection(asset.id)}
                    className="h-3.5 w-3.5 cursor-pointer accent-primary"
                    title="选择素材"
                  />
                </label>
                <div className={cn(viewSize === 'large' && 'sm:w-40 sm:shrink-0 2xl:w-44')}>
                  <AssetThumbnail asset={asset} viewSize={viewSize} onPreview={() => void openPreview(asset.id)} />
                </div>
                <div className={cn(
                  'flex flex-col p-2',
                  viewSize === 'compact' && 'p-1.5',
                  viewSize === 'normal' && 'min-h-24',
                  viewSize === 'large' && 'min-h-20 sm:min-h-44 sm:min-w-0 sm:flex-1'
                )}>
                  <div className="flex items-start justify-between gap-2">
                    <div className={cn('min-w-0', viewSize === 'large' && 'flex-1')}>
                      <p className={cn('truncate font-medium text-foreground', viewSize === 'compact' ? 'text-xs' : 'text-sm')} title={asset.name}>{asset.name}</p>
                      {viewSize !== 'compact' && (
                        <p className="truncate text-[11px] text-muted-foreground">{asset.sourceLabel} · {formatAssetSize(asset.sizeBytes)}</p>
                      )}
                    </div>
                    <button type="button" onClick={() => openEdit(asset)} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="编辑">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {viewSize === 'normal' && (
                    <div className="mt-2 flex h-4 flex-wrap gap-1 overflow-hidden">
                      {asset.tags.slice(0, 3).map(tag => <Badge key={tag} variant="outline" className="h-4 px-1.5 text-[10px]">{tag}</Badge>)}
                    </div>
                  )}
                  {viewSize === 'large' && (
                    <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-hidden">
                      <div className="flex min-h-5 flex-wrap gap-1 overflow-hidden">
                        {asset.tags.length > 0
                          ? asset.tags.slice(0, 6).map(tag => <Badge key={tag} variant="outline" className="h-5 px-1.5 text-[10px]">{tag}</Badge>)
                          : <span className="text-[11px] text-muted-foreground">无标签</span>}
                      </div>
                      <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                        {asset.note || asset.prompt || '暂无备注'}
                      </p>
                    </div>
                  )}
                  <div className={cn(
                    'flex justify-end gap-1',
                    viewSize === 'compact' ? 'pt-1' : 'mt-auto pt-2'
                  )}>
                    <Button variant="ghost" size="icon-xs" onClick={() => void runImageAction('copy', payload)} title="复制图片"><Copy className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => void runImageAction('download', payload)} title="下载"><Download className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => void runImageAction('use-as-reference', payload)} title="作为图生图参考"><Wand2 className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => setDeleteTarget(asset)} title="删除" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {visibleCount < filteredAssets.length && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>
            加载更多
          </Button>
        </div>
      )}

      {previewIndex !== null && previewImages[previewIndex] && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt="素材图片"
          initialIndex={previewIndex}
          onClose={closePreview}
          actionPayloads={visibleAssets.filter(isImageAsset).map(makePayload)}
          showAddToAssets={false}
        />,
        document.body,
      )}

      <Dialog
        open={!!editingAsset}
        onOpenChange={open => {
          if (!open && !metadataGenerating) {
            setEditingAsset(null);
            setMetadataSuggestion(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ImagePlus className="h-4 w-4" />
              编辑素材
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">名称</label>
              <Input value={editName} onChange={event => setEditName(event.target.value)} disabled={metadataGenerating} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">标签</label>
              <Input value={editTags} onChange={event => setEditTags(event.target.value)} placeholder="用空格或逗号分隔" disabled={metadataGenerating} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">备注</label>
              <Textarea value={editNote} onChange={event => setEditNote(event.target.value)} rows={4} disabled={metadataGenerating} />
            </div>
            {editingAsset && (
              <p className="text-xs text-muted-foreground">
                来源：{editingAsset.sourceLabel} · {editingAsset.width && editingAsset.height ? `${editingAsset.width}×${editingAsset.height} · ` : ''}{formatAssetSize(editingAsset.sizeBytes)}
              </p>
            )}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-foreground">AI 生成素材信息</p>
                  <p className="text-[11px] text-muted-foreground">生成后先预览，应用后再保存。</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void generateEditMetadata()}
                  disabled={metadataGenerating}
                >
                  {metadataGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {metadataGenerating ? '生成中…' : '生成建议'}
                </Button>
              </div>
              {metadataSuggestion && (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">建议标题</p>
                    <p className="rounded-md bg-background px-2 py-1 text-sm">{metadataSuggestion.name}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">建议标签</p>
                    <div className="flex flex-wrap gap-1 rounded-md bg-background p-2">
                      {metadataSuggestion.tags.map(tag => (
                        <Badge key={tag} variant="outline">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">建议备注</p>
                    <p className="whitespace-pre-wrap rounded-md bg-background px-2 py-1 text-sm leading-relaxed">{metadataSuggestion.note}</p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setMetadataSuggestion(null)} disabled={metadataGenerating}>丢弃建议</Button>
                    <Button size="sm" onClick={applyMetadataSuggestion} disabled={metadataGenerating}>应用到表单</Button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                variant="outline"
                onClick={() => {
                  setEditingAsset(null);
                  setMetadataSuggestion(null);
                }}
                disabled={metadataGenerating}
              >
                取消
              </Button>
              <Button onClick={() => void saveEdit()} disabled={metadataGenerating}>
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={textDialogOpen} onOpenChange={setTextDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              新建提示词素材
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={textContent}
              onChange={event => setTextContent(event.target.value)}
              rows={8}
              placeholder="粘贴或输入提示词..."
            />
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                variant="outline"
                onClick={() => {
                  setTextDialogOpen(false);
                  setTextContent('');
                }}
              >
                取消
              </Button>
              <Button onClick={() => void saveTextAsset()} disabled={!textContent.trim()}>
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {deleteTarget && createPortal(
        <ConfirmDialog
          title="删除素材"
          message={`确定要删除「${isTextAsset(deleteTarget) ? deleteTarget.content.slice(0, 30) || '提示词素材' : deleteTarget.name}」吗？不会删除历史生成记录。`}
          confirmText="删除"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />,
        document.body,
      )}

      {deleteSelectedOpen && createPortal(
        <ConfirmDialog
          title="删除选中素材"
          message={`确定要删除选中的 ${selectedCount} 项素材吗？不会删除历史生成记录。`}
          confirmText="删除"
          onConfirm={() => void confirmDeleteSelected()}
          onCancel={() => setDeleteSelectedOpen(false)}
        />,
        document.body,
      )}
    </section>
  );
}
