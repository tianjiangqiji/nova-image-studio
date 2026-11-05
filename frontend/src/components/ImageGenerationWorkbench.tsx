'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, CloudUpload, FileText, ImagePlus, Info, LayoutTemplate, Loader2, Save, Sparkles, X, Zap } from 'lucide-react';
import { AttachmentChips } from './AttachmentChips';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { QuickPromptDialog } from '@/components/QuickPromptDialog';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { AgentAssetPickerDialog, AgentTextAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { GenerationParamsBar, type GenerationParamsValue } from '@/components/GenerationParamsBar';
import { LayoutSpecDialog } from '@/components/layout/LayoutSpecDialog';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { composePromptWithLayout, isLayoutSpecEmpty, parseLayoutSpec, renderLayoutReferenceImage, stringifyLayoutSpec, stripLayoutSection, type LayoutSpec } from '@/lib/layout-spec';
import { addTextAsset, getAssetBlob, type ImageAsset, type TextAsset } from '@/lib/asset-store';
import { MODEL_IMAGE_LIMITS, MODEL_OPTIONS, type ModelId } from '@/lib/gemini-config';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  detectClosestAspectRatio,
  findReferenceCapableModel,
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getGptImageAdvancedParamsForModel,
  getModelMaxRefImages,
  getValidOutputSizes,
  normalizeCustomImageSize,
  normalizeModel,
  sanitizeLayoutForModel,
  supportsCustomSize,
  supportsReferenceImages,
  supportsGptImageMarkup,
  supportsNativeImageOutput,
  type GptImageOutputFormat,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  PARALLEL_COUNT_VALUES,
  type ParallelCount,
} from '@/lib/model-capabilities';
import { prepareUploadImage, getOptimizationBadge } from '@/lib/upload-image-cache';
import { MAX_UPLOAD_SIZE_BYTES } from '@/lib/constants';
import { dispatchImageActionToast } from '@/lib/image-actions';
import type { AspectRatio, OutputSize, RefImageData, GptImageMarkup } from '@/lib/job-store';
import { ImageAnnotationEditor } from '@/components/canvas/components/image-annotation-editor';
import type { ImageFormSettings } from '@/lib/form-settings';
import type { ImageToImageSubmitInput, TextToImageSubmitInput } from '@/lib/workspace-task-service';
import { cn } from '@/lib/utils';

const WORKBENCH_SETTINGS_KEY = 'nova-image-generation-settings';
const T2I_SETTINGS_KEY = 'nova-t2i-settings';
const I2I_SETTINGS_KEY = 'nova-i2i-settings';
const MAX_ASSET_IMPORTS = 5;

type WorkbenchMode = 'text-to-image' | 'image-to-image';
type WorkbenchSettings = ImageFormSettings;

interface UploadedFile {
  id: string;
  name: string;
  preview: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

/**
 * 构图 JSON 实时渲染出的线框参考图（data URL）→ File。
 * 参考图只是预览方块的本地成像，不走模型、不落素材库。
 */
function layoutSketchDataUrlToPngFile(dataUrl: string): File {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], '构图参考图.png', { type: 'image/png' });
}

interface ImageGenerationWorkbenchProps {
  wideMode?: boolean;
  onSubmitText: (data: TextToImageSubmitInput) => void;
  onSubmitImage: (data: ImageToImageSubmitInput) => void;
  disabled?: boolean;
  onDraftConsumed?: () => void;
  onConfigureApiKey?: () => void;
  initialData?: {
    prompt?: string;
    outputSize?: OutputSize;
    customSize?: string;
    aspectRatio?: AspectRatio;
    temperature?: number;
    model?: ModelId;
    gptImageQuality?: GptImageQuality;
    gptImageStyle?: GptImageStyle;
    gptImageBackground?: GptImageBackground;
    gptImageOutputFormat?: GptImageOutputFormat;
    parallelCount?: ParallelCount;
    refImages?: RefImageData[];
    gptImageMarkup?: GptImageMarkup;
    /** 重试/恢复带回的构图规范 */
    layoutSpec?: LayoutSpec | null;
  };
  referenceDraft?: {
    id: number;
    refImages: RefImageData[];
    prompt?: string;
  } | null;
  /** 素材库「编辑构图」带入的构图规范草稿：解析后进构图弹窗继续编辑 */
  layoutDraft?: {
    id: number;
    content: string;
    assetId?: string;
  } | null;
  onLayoutDraftConsumed?: () => void;
}

function hasStoredSettings(settings: Partial<WorkbenchSettings>): boolean {
  return Object.keys(settings).length > 0;
}

function getSettingsFallback(preferImageSettings: boolean): Partial<WorkbenchSettings> {
  const saved = loadJsonFromStorage<WorkbenchSettings>(WORKBENCH_SETTINGS_KEY);
  if (hasStoredSettings(saved)) return saved;

  const primary = loadJsonFromStorage<WorkbenchSettings>(preferImageSettings ? I2I_SETTINGS_KEY : T2I_SETTINGS_KEY);
  if (hasStoredSettings(primary)) return primary;

  return loadJsonFromStorage<WorkbenchSettings>(preferImageSettings ? T2I_SETTINGS_KEY : I2I_SETTINGS_KEY);
}

export function ImageGenerationWorkbench({
  onSubmitText,
  onSubmitImage,
  disabled = false,
  onDraftConsumed,
  onConfigureApiKey,
  initialData,
  referenceDraft,
  layoutDraft,
  onLayoutDraftConsumed,
}: ImageGenerationWorkbenchProps) {
  const [prompt, setPrompt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const [gptImageMarkup, setGptImageMarkup] = useState<GptImageMarkup | undefined>();
  const [markupEditorOpen, setMarkupEditorOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const [model, setModel] = useState<ModelId>('gemini-3-pro-image-preview');
  const [outputSize, setOutputSize] = useState<OutputSize>('1K');
  const [customSize, setCustomSize] = useState<string | undefined>(undefined);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [temperature, setTemperature] = useState<number>(1);
  const [gptImageAdvancedParams, setGptImageAdvancedParams] = useState<GptImageAdvancedParams>(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  const [parallelCount, setParallelCount] = useState<ParallelCount>(1);
  const [settingsReady, setSettingsReady] = useState(false);
  const [outputFormat, setOutputFormat] = useState<'png' | 'svg'>('png');

  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [textAssetPickerOpen, setTextAssetPickerOpen] = useState(false);
  const [pendingTextAsset, setPendingTextAsset] = useState<TextAsset | null>(null);

  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

  const [layoutSpec, setLayoutSpec] = useState<LayoutSpec | null>(null);
  const [layoutDialogOpen, setLayoutDialogOpen] = useState(false);
  // 从素材库带进来的构图素材 id：构图弹窗「存入素材库」时回写原素材
  const [layoutSourceAssetId, setLayoutSourceAssetId] = useState('');
  // 已自动生成过参考图的构图签名，避免同一份构图重复渲染
  const layoutReferenceSignatureRef = useRef('');

  const modelLimit = MODEL_IMAGE_LIMITS[model] || { max: getModelMaxRefImages(model), description: '最多 1 张参考图片' };
  const maxImages = modelLimit.max;
  const refsSupported = maxImages > 0;
  const aspectRatioOptions = useMemo(() => getAspectRatioOptions(model, outputSize), [model, outputSize]);
  const currentMode: WorkbenchMode = pendingFiles.length > 0 ? 'image-to-image' : 'text-to-image';
  const autoLayoutLocked = outputSize === 'auto';
  const nativeOutputSupported = supportsNativeImageOutput(model);
  const activeOutputFormat = nativeOutputSupported ? outputFormat : 'png';
  const markupSupported = supportsGptImageMarkup(model) && activeOutputFormat === 'png';
  const activeMarkup = markupSupported && gptImageMarkup?.referenceId === pendingFiles[0]?.id
    ? gptImageMarkup : undefined;
  // 删除/更换首图或切换到不支持的模型后，不得把旧标注套到其他参考图。
  if (gptImageMarkup && (!markupSupported || gptImageMarkup.referenceId !== pendingFiles[0]?.id)) {
    setGptImageMarkup(undefined);
  }
  if (markupEditorOpen && (!markupSupported || !pendingFiles[0])) {
    setMarkupEditorOpen(false);
  }
  const disabledMessage = '请先在设置中配置 Nova API 密钥，配置完成后即可开始生成图片。';

  const handleParamsChange = useCallback((patch: Partial<GenerationParamsValue>) => {
    if (patch.model !== undefined) {
      setModel(patch.model);
      if (!supportsReferenceImages(patch.model)) {
        setPendingFiles((prev) => {
          if (prev.length > 0) {
            setUploadError('当前模型不支持参考图，已清除参考图');
            return [];
          }
          return prev;
        });
      }
    }
    if (patch.outputSize !== undefined) setOutputSize(patch.outputSize);
    if ('customSize' in patch) setCustomSize(patch.customSize);
    if (patch.aspectRatio !== undefined) setAspectRatio(patch.aspectRatio);
    if (patch.temperature !== undefined) setTemperature(patch.temperature);
    if (patch.parallelCount !== undefined) setParallelCount(patch.parallelCount);
    if (patch.gptImageAdvancedParams !== undefined) setGptImageAdvancedParams(patch.gptImageAdvancedParams);
  }, []);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
  }, [prompt]);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      const useInitial = Boolean(initialData);
      const saved = getSettingsFallback(Boolean(initialData?.refImages?.length));
      const nextModel = normalizeModel(useInitial && initialData?.model ? initialData.model : saved.model);
      const candidateOutputSize: OutputSize = useInitial && initialData?.outputSize
        ? initialData.outputSize
        : (saved.outputSize || '1K');
      const candidateAspectRatio: AspectRatio = useInitial && initialData?.aspectRatio
        ? initialData.aspectRatio
        : (saved.aspectRatio || '1:1');
      const sanitized = sanitizeLayoutForModel(nextModel, candidateOutputSize, candidateAspectRatio);
      const nextOutputSize = sanitized.outputSize;
      const nextAspectRatio = sanitized.aspectRatio;
      const nextCustomSize = supportsCustomSize(nextModel) && nextOutputSize !== 'auto'
        ? normalizeCustomImageSize(useInitial ? initialData?.customSize : saved.customSize, getCustomSizeMaxSide(nextModel))
        : undefined;
      const nextTemperature = useInitial && typeof initialData?.temperature === 'number' && initialData.temperature >= 0 && initialData.temperature <= 2
        ? initialData.temperature
        : (typeof saved.temperature === 'number' && saved.temperature >= 0 && saved.temperature <= 2 ? saved.temperature : 1);
      const nextAdvancedParams = getGptImageAdvancedParamsForModel(nextModel, {
        quality: useInitial ? initialData?.gptImageQuality : saved.gptImageQuality,
        style: useInitial ? initialData?.gptImageStyle : saved.gptImageStyle,
        background: useInitial ? initialData?.gptImageBackground : saved.gptImageBackground,
      });
      const nextParallelCount: ParallelCount = useInitial && initialData?.parallelCount && PARALLEL_COUNT_VALUES.includes(initialData.parallelCount)
        ? initialData.parallelCount
        : (saved.parallelCount && PARALLEL_COUNT_VALUES.includes(saved.parallelCount) ? saved.parallelCount : 1);

      setModel(nextModel);
      setOutputSize(nextOutputSize);
      setCustomSize(nextCustomSize);
      setAspectRatio(nextAspectRatio);
      setTemperature(nextTemperature);
      setGptImageAdvancedParams(nextAdvancedParams);
      setParallelCount(nextParallelCount);
      setOutputFormat((useInitial ? initialData?.gptImageOutputFormat : saved.gptImageOutputFormat) === 'svg' ? 'svg' : 'png');
      if (useInitial) {
        // 任务里存的提示词已含构图段落，恢复时剥掉，避免再次提交时重复拼接
        const restoredPrompt = initialData?.layoutSpec ? stripLayoutSection(initialData.prompt || '') : (initialData?.prompt || '');
        setPrompt(restoredPrompt);
        setLayoutSpec(initialData?.layoutSpec || null);
        setGptImageMarkup(initialData?.gptImageMarkup);
        setPendingFiles((initialData?.refImages || []).map(img => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '已恢复',
        })));
      }

      setSettingsReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [initialData]);

  useEffect(() => {
    if (!settingsReady) return;
    saveJsonToStorage(WORKBENCH_SETTINGS_KEY, {
      gptImageOutputFormat: activeOutputFormat,
      model,
      outputSize,
      customSize,
      aspectRatio,
      temperature,
      gptImageQuality: gptImageAdvancedParams.quality,
      gptImageStyle: gptImageAdvancedParams.style,
      gptImageBackground: gptImageAdvancedParams.background,
      parallelCount,
    });
  }, [model, outputSize, customSize, aspectRatio, temperature, gptImageAdvancedParams, parallelCount, settingsReady, activeOutputFormat]);

  const handleOptimize = useCallback(() => {
    const textModel = requireDefaultConfiguredTextModel('promptOptimize');
    if (!prompt.trim()) return;

    optimizeHandleRef.current?.abort();
    setOptimizedText('');
    setOptimizeError(null);
    setOptimizing(true);
    setOptimizeOpen(true);

    const images = pendingFiles.map(f => ({ dataUrl: f.dataUrl, mimeType: f.mimeType }));
    const handle = streamPromptOptimize(
      { apiKey: textModel.apiKey, model: textModel.id, mode: currentMode, prompt: prompt.trim(), ...(images.length > 0 ? { images } : {}) },
      {
        onDelta(token) { setOptimizedText(prev => prev + token); },
        onDone() { setOptimizing(false); },
        onError(err) { setOptimizeError(err.message); setOptimizing(false); },
      },
      textModel.baseUrl,
    );
    optimizeHandleRef.current = handle;
  }, [currentMode, pendingFiles, prompt]);

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText('');
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText) setPrompt(optimizedText);
    optimizeHandleRef.current = null;
    setOptimizedText('');
    setOptimizeError(null);
  }, [optimizedText]);

  const consumedDraftRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!referenceDraft?.refImages.length) return;
    if (consumedDraftRef.current === referenceDraft.id) return;
    consumedDraftRef.current = referenceDraft.id;
    if (referenceDraft.prompt) {
      setPrompt(referenceDraft.prompt);
    }

    let activeModel = model;
    let activeMax = maxImages;
    if (!supportsReferenceImages(activeModel) || activeMax <= 0) {
      const switched = findReferenceCapableModel(activeModel);
      if (!switched) {
        setUploadError('当前没有支持参考图的模型，请先在设置中配置可编辑模型');
        onDraftConsumed?.();
        return;
      }
      activeModel = switched;
      activeMax = getModelMaxRefImages(switched);
      setModel(switched);
      const sanitized = sanitizeLayoutForModel(switched, outputSize, aspectRatio);
      setOutputSize(sanitized.outputSize);
      setAspectRatio(sanitized.aspectRatio);
      if (sanitized.outputSize === 'auto' || !supportsCustomSize(switched)) {
        setCustomSize(undefined);
      }
      setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(switched, gptImageAdvancedParams));
      const label = MODEL_OPTIONS.find((o) => o.value === switched)?.label || switched;
      dispatchImageActionToast(`已切换到支持参考图的模型：${label}`, 'info');
    }

    setPendingFiles((prev) => {
      const existingIds = new Set(prev.map((file) => file.id));
      const remainingSlots = Math.max(0, activeMax - prev.length);
      if (remainingSlots <= 0) {
        setUploadError(`${MODEL_OPTIONS.find((o) => o.value === activeModel)?.label} 最多支持 ${activeMax} 张参考图`);
        return prev;
      }
      const incoming: UploadedFile[] = referenceDraft.refImages
        .filter((img) => !existingIds.has(img.id))
        .slice(0, remainingSlots)
        .map((img) => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '参考',
        }));
      if (incoming.length < referenceDraft.refImages.length) {
        setUploadError(`${MODEL_OPTIONS.find((o) => o.value === activeModel)?.label} 最多支持 ${activeMax} 张参考图，已添加可容纳的图片`);
      } else {
        setUploadError(null);
      }
      return incoming.length > 0 ? [...prev, ...incoming] : prev;
    });
    onDraftConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- referenceDraft.id is the stable identity; refImages is consumed via ref guard
  }, [maxImages, model, onDraftConsumed, referenceDraft?.id]);

  const consumedLayoutDraftRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!layoutDraft?.content) return;
    if (consumedLayoutDraftRef.current === layoutDraft.id) return;
    consumedLayoutDraftRef.current = layoutDraft.id;
    // 与 initialData 同一范式：微任务内落状态，避免 effect 同步 setState 级联渲染
    queueMicrotask(() => {
      const parsed = parseLayoutSpec(layoutDraft.content);
      if (!parsed) {
        dispatchImageActionToast('该素材不是有效的构图规范', 'error');
        onLayoutDraftConsumed?.();
        return;
      }
      setLayoutSpec(parsed);
      setLayoutSourceAssetId(layoutDraft.assetId || '');
      setLayoutDialogOpen(true);
      onLayoutDraftConsumed?.();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutDraft.id is the stable identity; content is consumed via ref guard
  }, [layoutDraft?.id, onLayoutDraftConsumed]);

  const detectImageAspectRatio = useCallback(async (dataUrl: string): Promise<AspectRatio | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(detectClosestAspectRatio(img.width, img.height, aspectRatioOptions));
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }, [aspectRatioOptions]);

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    if (maxImages <= 0) {
      setUploadError('当前模型不支持参考图，请切换到支持编辑的模型');
      return;
    }
    const filesToProcess = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (filesToProcess.length === 0) {
      setUploadError('请选择图像文件');
      return;
    }
    if (pendingFiles.length + filesToProcess.length > maxImages) {
      setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} ${modelLimit.description}`);
      return;
    }

    setLoading(true);
    setUploadError(null);

    try {
      const newFiles: UploadedFile[] = [];
      let firstDetectedRatio: AspectRatio | null = null;

      for (const file of filesToProcess) {
        const optimized = await prepareUploadImage(file);
        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          setUploadError(`文件过大: ${file.name}，压缩后仍超过 10MB`);
          continue;
        }

        if (!autoLayoutLocked && newFiles.length === 0 && pendingFiles.length === 0) {
          firstDetectedRatio = await detectImageAspectRatio(optimized.preview);
        }

        newFiles.push({
          id: optimized.id,
          name: optimized.name,
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: getOptimizationBadge(optimized.originalSize, optimized.processedSize, optimized.cacheHit),
        });
      }

      setPendingFiles(prev => {
        const existingIds = new Set(prev.map(f => f.id));
        const uniqueNew = newFiles.filter(f => !existingIds.has(f.id));
        return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
      });

      if (firstDetectedRatio && pendingFiles.length === 0) {
        setAspectRatio(firstDetectedRatio);
      }
    } catch {
      setUploadError('文件读取失败');
    } finally {
      setLoading(false);
    }
  }, [autoLayoutLocked, detectImageAspectRatio, maxImages, model, pendingFiles.length]);

  const handleImportAssets = useCallback(async (selectedAssets: ImageAsset[]) => {
    if (selectedAssets.length === 0) return;
    if (maxImages <= 0) {
      setUploadError('当前模型不支持参考图，请切换到支持编辑的模型');
      return;
    }

    const remainingSlots = Math.max(0, maxImages - pendingFiles.length);
    if (remainingSlots <= 0) {
      setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} 最多支持 ${maxImages} 张参考图`);
      return;
    }

    setLoading(true);
    setUploadError(null);

    try {
      const importedFiles: UploadedFile[] = [];
      let firstDetectedRatio: AspectRatio | null = null;

      for (const asset of selectedAssets.slice(0, Math.min(remainingSlots, MAX_ASSET_IMPORTS))) {
        const blob = await getAssetBlob(asset.id);
        if (!blob) continue;

        const file = new File([blob], asset.name, { type: asset.mimeType || blob.type || 'image/png' });
        const optimized = await prepareUploadImage(file);

        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          setUploadError(`文件过大: ${asset.name}，压缩后仍超过 10MB`);
          continue;
        }

        if (!autoLayoutLocked && importedFiles.length === 0 && pendingFiles.length === 0) {
          firstDetectedRatio = await detectImageAspectRatio(optimized.preview);
        }

        importedFiles.push({
          id: optimized.id,
          name: optimized.name,
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: '素材库',
        });
      }

      setPendingFiles(prev => {
        const existingIds = new Set(prev.map(f => f.id));
        const uniqueImported = importedFiles.filter(f => !existingIds.has(f.id));
        return uniqueImported.length > 0 ? [...prev, ...uniqueImported] : prev;
      });

      if (firstDetectedRatio && pendingFiles.length === 0) {
        setAspectRatio(firstDetectedRatio);
      }

      if (selectedAssets.length > remainingSlots) {
        setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} 最多支持 ${maxImages} 张参考图，已导入可容纳的图片`);
      }
    } catch {
      setUploadError('素材导入失败');
    } finally {
      setLoading(false);
    }
  }, [autoLayoutLocked, detectImageAspectRatio, maxImages, model, pendingFiles.length]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!disabled && e.dataTransfer.files.length > 0) {
      void processFiles(e.dataTransfer.files);
    }
  }, [disabled, processFiles]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragOver(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void processFiles(e.target.files);
      e.target.value = '';
    }
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled || loading || maxImages <= 0) return;
      const target = e.target as HTMLElement;
      if (!formRef.current?.contains(target)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void processFiles(imageFiles);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [disabled, loading, maxImages, processFiles]);

  const handleRemovePending = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const applyTextAsset = useCallback((asset: TextAsset) => {
    setPrompt(asset.content);
    setPendingTextAsset(null);
  }, []);

  const handleTextAssetConfirm = useCallback((asset: TextAsset) => {
    if (prompt.trim() && prompt.trim() !== asset.content.trim()) {
      setPendingTextAsset(asset);
      return;
    }
    applyTextAsset(asset);
  }, [applyTextAsset, prompt]);

  const handleSavePromptAsset = useCallback(async () => {
    const content = composePromptWithLayout(prompt, layoutSpec);
    if (!content.trim()) return;
    try {
      await addTextAsset({
        content,
        sourceKind: currentMode,
        sourceLabel: '生图工作台',
      });
      dispatchImageActionToast('提示词素材已保存', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  }, [currentMode, layoutSpec, prompt]);

  const handleSubmit = () => {
    const finalPrompt = composePromptWithLayout(prompt, layoutSpec);
    if (!finalPrompt.trim() || disabled || loading) return;

    const modelWithBilling = model;
    const carriedLayoutSpec = layoutSpec && !isLayoutSpecEmpty(layoutSpec) ? layoutSpec : undefined;
    if (pendingFiles.length > 0) {
      onSubmitImage({
        prompt: finalPrompt,
        files: pendingFiles,
        gptImageMarkup: activeMarkup,
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        model: modelWithBilling,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
        layoutSpec: carriedLayoutSpec,
        gptImageOutputFormat: activeOutputFormat,
      });
    } else {
      onSubmitText({
        prompts: [finalPrompt],
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        model: modelWithBilling,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
        layoutSpec: carriedLayoutSpec,
        gptImageOutputFormat: activeOutputFormat,
      });
    }

    setPendingFiles([]);
    setGptImageMarkup(undefined);
    setPrompt('');
    setUploadError(null);
    setLayoutSpec(null);
    onDraftConsumed?.();
  };

  const handleClearDraft = () => {
    setPrompt('');
    setPendingFiles([]);
    setUploadError(null);
    setLayoutSpec(null);
    onDraftConsumed?.();
  };

  // 构图 JSON → 预览同款线框方块图，作为图生图参考图（本地渲染，不调模型、不落素材库）
  const applyLayoutReference = useCallback(
    async (spec: LayoutSpec) => {
      const dataUrl = renderLayoutReferenceImage(spec);
      if (!dataUrl) {
        dispatchImageActionToast('当前环境无法渲染参考图', 'error');
        return;
      }

      // 参考图必须落在支持编辑的模型上：与 referenceDraft 消费同一套切换逻辑
      let activeModel = model;
      let activeMax = getModelMaxRefImages(model);
      if (!supportsReferenceImages(activeModel) || activeMax <= 0) {
        const switched = findReferenceCapableModel(model);
        if (!switched) {
          setUploadError('当前没有支持参考图的模型，请先在设置中配置可编辑模型');
          return;
        }
        activeModel = switched;
        activeMax = getModelMaxRefImages(switched);
        setModel(switched);
        const sanitized = sanitizeLayoutForModel(switched, outputSize, aspectRatio);
        setOutputSize(sanitized.outputSize);
        setAspectRatio(sanitized.aspectRatio);
        setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(switched, gptImageAdvancedParams));
        dispatchImageActionToast(`已切换到支持参考图的模型：${MODEL_OPTIONS.find((o) => o.value === switched)?.label || switched}`, 'info');
      }

      setUploadError(null);
      try {
        const optimized = await prepareUploadImage(layoutSketchDataUrlToPngFile(dataUrl));
        const incoming: UploadedFile = {
          id: optimized.id,
          name: '构图参考图.png',
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: '构图参考图',
        };
        setPendingFiles(prev => {
          // 构图变化只换图不堆叠：先移除旧的构图参考图条目
          const withoutPrev = prev.filter(file => file.badge !== '构图参考图');
          return [incoming, ...withoutPrev].slice(0, activeMax);
        });
      } catch {
        dispatchImageActionToast('参考图渲染失败，请重试', 'error');
      }
    },
    [aspectRatio, gptImageAdvancedParams, model, outputSize],
  );

  // 构图确认后自动加入参考图，无需手动点击；同一份构图只生成一次
  useEffect(() => {
    if (!layoutSpec || isLayoutSpecEmpty(layoutSpec)) {
      layoutReferenceSignatureRef.current = '';
      return;
    }
    const signature = stringifyLayoutSpec(layoutSpec);
    if (layoutReferenceSignatureRef.current === signature) return;
    layoutReferenceSignatureRef.current = signature;
    queueMicrotask(() => {
      void applyLayoutReference(layoutSpec);
    });
  }, [applyLayoutReference, layoutSpec]);

  // 退出构图模式：清掉构图与其自动生成的参考图
  const handleExitLayoutMode = useCallback(() => {
    setLayoutSpec(null);
    setLayoutSourceAssetId('');
    setPendingFiles(prev => prev.filter(file => file.badge !== '构图参考图'));
    dispatchImageActionToast('已退出构图模式', 'info');
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasLayout = !isLayoutSpecEmpty(layoutSpec);
  const canSubmit = (prompt.trim().length > 0 || hasLayout) && !disabled && !loading;
  const canClear = prompt.trim().length > 0 || pendingFiles.length > 0 || hasLayout;

  return (
    <div ref={formRef} className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-xl shadow-md">
        {disabled ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-4 px-4 py-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Info className="h-5 w-5" />
            </div>
            <div className="max-w-md">
              <p className="text-base font-medium text-foreground">API 密钥未配置</p>
              <p className="mt-2 text-sm text-muted-foreground">{disabledMessage}</p>
            </div>
            <Button onClick={() => setMissingApiKeyDialogOpen(true)}>配置</Button>
          </div>
        ) : (
          <>
            <div className="p-4 pb-2">
              <div className="flex gap-3">
                <div
                  onDrop={refsSupported ? handleDrop : undefined}
                  onDragOver={refsSupported ? handleDragOver : (e) => e.preventDefault()}
                  onDragLeave={() => setIsDragOver(false)}
                  className={cn(
                    'relative flex-[3] overflow-hidden rounded-xl border-2 border-dashed px-6 py-8 text-center transition-all',
                    !refsSupported
                      ? 'cursor-not-allowed border-border/60 bg-muted/30 opacity-60'
                      : isDragOver
                        ? 'border-primary bg-primary/20'
                        : 'cursor-pointer border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10',
                  )}
                >
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileSelect}
                    disabled={loading || !refsSupported}
                    className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden opacity-0 disabled:cursor-not-allowed"
                    style={{ fontSize: 0 }}
                  />
                  <CloudUpload className={cn('mx-auto mb-1 h-6 w-6', isDragOver && refsSupported ? 'text-primary' : 'text-muted-foreground')} />
                  <p className="text-sm font-medium">
                    {!refsSupported
                      ? '当前模型不支持参考图'
                      : loading
                        ? '读取中...'
                        : isDragOver
                          ? '将图像拖放到这里'
                          : '参考图（可选）'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {refsSupported ? '点击选择 · 拖放 · Ctrl+V 粘贴' : '请切换到支持编辑的模型'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pendingFiles.length} / {maxImages} 张
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAssetPickerOpen(true)}
                  disabled={loading || !refsSupported || pendingFiles.length >= maxImages}
                  title={refsSupported ? '从素材库导入参考图' : '当前模型不支持参考图'}
                  className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-3 py-4 text-center transition-all hover:border-primary/50 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ImagePlus className="h-6 w-6 text-muted-foreground" />
                  <span className="text-sm font-medium">素材库</span>
                  <span className="text-xs text-muted-foreground">{refsSupported ? '导入参考图' : '不支持参考图'}</span>
                </button>
              </div>
            </div>

            {pendingFiles.length > 0 && (
              <div className="px-4 pb-2">
                <AttachmentChips
                  files={pendingFiles}
                  onRemove={handleRemovePending}
                  sourceKind="upload"
                  sourceLabel="生图参考图"
                  prompt={prompt}
                  showDownload={false}
                  showCopy
                  showUseAsReference={false}
                />
                {markupSupported && (
                  <div className="mt-2 space-y-2 rounded-lg border border-border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" size="xs" disabled={loading} onClick={() => setMarkupEditorOpen(true)}>
                        {activeMarkup ? '重新标注图 1' : '标注图 1'}
                      </Button>
                      {activeMarkup && <Button type="button" variant="ghost" size="xs" onClick={() => setGptImageMarkup(undefined)}>清除标注</Button>}
                      <span className="text-xs text-muted-foreground">Markup · 圈选修改区域，独立透明图层随图 1 提交</span>
                    </div>
                    {activeMarkup && (
                      <div className="relative inline-block overflow-hidden rounded-md border border-border">
                        <img src={pendingFiles[0].dataUrl} alt="标注参考图预览" className="max-h-32 max-w-full object-contain" />
                        <img src={activeMarkup.dataUrl} alt="独立透明标注图层" className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={pendingFiles.length > 0 ? '描述如何调整参考图...' : '描述你想要生成的图像...'}
              rows={3}
              className="resize-none rounded-none border-0 bg-transparent px-3 pt-3 placeholder:text-placeholder focus-visible:border-0 focus-visible:ring-0 sm:px-4 sm:pt-4"
            />

            <div className="px-3 pt-2 pb-2 sm:px-4">
              <GenerationParamsBar
                value={{ model, outputSize, customSize, aspectRatio, temperature, parallelCount, gptImageAdvancedParams }}
                onChange={handleParamsChange}
              />
            </div>

            <div role="group" aria-label="生图工具栏" className="flex w-full flex-wrap items-center justify-end gap-2 px-3 pb-2 sm:px-4">
              <Button variant="ghost" size="icon" onClick={() => setQuickPromptOpen(true)} title="快速提示词">
                <Zap className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setTextAssetPickerOpen(true)} title="导入提示词素材">
                <FileText className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => void handleSavePromptAsset()} disabled={!prompt.trim() && !hasLayout} title="存为提示词素材">
                <Save className="w-4 h-4" />
              </Button>
              {nativeOutputSupported && (
                <label className="flex h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap px-1 text-[11px] text-foreground">
                  <Switch size="sm" variant="neutral" checked={outputFormat === 'svg'} onCheckedChange={checked => setOutputFormat(checked ? 'svg' : 'png')} aria-label="SVG 矢量图" />
                  SVG 矢量图
                </label>
              )}
              <div
                className={cn(
                  'flex items-center rounded-md',
                  hasLayout ? 'bg-primary text-primary-foreground' : 'bg-transparent',
                )}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('gap-1.5', hasLayout && 'text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground')}
                  onClick={() => setLayoutDialogOpen(true)}
                  title={hasLayout ? `构图模式（已设 ${layoutSpec?.objects.length ?? 0} 个物体）` : '构图模式'}
                >
                  <LayoutTemplate className="w-4 h-4" />
                  <span className="text-xs">构图</span>
                </Button>
                {hasLayout && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-0.5 text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground"
                    onClick={handleExitLayoutMode}
                    title="退出构图模式"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
              <Button variant="ghost" size="icon" onClick={handleOptimize} disabled={!prompt.trim()} title="优化提示词">
                <Sparkles className="w-4 h-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={handleClearDraft} disabled={!canClear} title="清空提示词和图片">
                <X className="w-5 h-5" />
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit} size="icon" title={currentMode === 'image-to-image' ? '按图生图提交' : '按文生图提交'}>
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowUp className="w-5 h-5" />}
              </Button>
            </div>
          </>
        )}
      </div>

      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => onConfigureApiKey?.()}
      />
      <QuickPromptDialog
        open={quickPromptOpen}
        onOpenChange={setQuickPromptOpen}
        currentMode={currentMode}
        currentPrompt={prompt}
        onSelect={setPrompt}
      />
      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={(open) => { if (!open) handleOptimizeCancel(); setOptimizeOpen(open); }}
        originalPrompt={prompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />
      <AgentAssetPickerDialog
        open={assetPickerOpen}
        maxSelected={Math.min(MAX_ASSET_IMPORTS, Math.max(1, maxImages - pendingFiles.length))}
        onOpenChange={setAssetPickerOpen}
        onConfirm={(assets) => void handleImportAssets(assets)}
      />
      <AgentTextAssetPickerDialog
        open={textAssetPickerOpen}
        onOpenChange={setTextAssetPickerOpen}
        onConfirm={handleTextAssetConfirm}
      />
      <LayoutSpecDialog
        open={layoutDialogOpen}
        onOpenChange={setLayoutDialogOpen}
        initialSpec={layoutSpec}
        defaultAspectRatio={aspectRatio}
        backgroundImageUrl={pendingFiles[0]?.dataUrl}
        initialAssetId={layoutSourceAssetId}
        onConfirm={setLayoutSpec}
      />
      {markupEditorOpen && markupSupported && pendingFiles[0] && createPortal(
        <ImageAnnotationEditor
          key={pendingFiles[0].id}
          src={pendingFiles[0].dataUrl}
          title="图 1 · Markup 标注"
          outputMode="markup"
          initialPrompt={prompt}
          onClose={() => setMarkupEditorOpen(false)}
          onSubmit={(dataUrl, editPrompt, originalPng) => {
            const first = pendingFiles[0];
            if (!first || !originalPng) return;
            setPendingFiles(files => files.map(file => file.id === first.id
              ? { ...file, dataUrl: originalPng, preview: originalPng, mimeType: 'image/png', name: file.name.replace(/\.[^.]+$/, '') + '.png' }
              : file));
            setGptImageMarkup({ referenceId: first.id, dataUrl });
            setPrompt(editPrompt);
            setMarkupEditorOpen(false);
          }}
        />,
        document.body,
      )}
      {pendingTextAsset && createPortal(
        <ConfirmDialog
          title="覆盖当前提示词"
          message="将用素材内容覆盖当前输入框，是否继续？"
          confirmText="覆盖"
          variant="default"
          onConfirm={() => applyTextAsset(pendingTextAsset)}
          onCancel={() => setPendingTextAsset(null)}
        />,
        document.body,
      )}
    </div>
  );
}
