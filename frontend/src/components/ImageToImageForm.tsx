'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AttachmentChips } from './AttachmentChips';
import { ArrowUp, Check, Loader2, Info, Maximize, RectangleHorizontal, Thermometer, CloudUpload, Sparkles, Copy, X, Zap, ImagePlus, FileText, Save } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { CustomSizeDialog } from '@/components/CustomSizeDialog';
import { GptImageAdvancedParamsControl } from '@/components/GptImageAdvancedParamsControl';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { QuickPromptDialog } from '@/components/QuickPromptDialog';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { AgentAssetPickerDialog, AgentTextAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { addTextAsset, getAssetBlob, type ImageAsset, type TextAsset } from '@/lib/asset-store';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { MODEL_OPTIONS, MODEL_IMAGE_LIMITS, isGptImageModel, type ModelId } from '@/lib/gemini-config';
import {
  detectClosestAspectRatio,
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getOutputSizeLabel,
  getSizeOptions,
  getValidOutputSizes,
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  getGptImageAdvancedParamsForModel,
  normalizeCustomImageSize,
  normalizeModel,
  supportsGptImageAdvancedParams,
  supportsAutoLayout,
  supportsCustomSize,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import { prepareUploadImage, getOptimizationBadge } from '@/lib/upload-image-cache';
import { MAX_UPLOAD_SIZE_BYTES } from '@/lib/constants';
import { dispatchImageActionToast } from '@/lib/image-actions';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import type { RefImageData, OutputSize, AspectRatio } from '@/lib/job-store';
import type { ImageFormSettings } from '@/lib/form-settings';


const I2I_SETTINGS_KEY = 'nova-i2i-settings';
const MAX_ASSET_IMPORTS = 5;

type I2ISettings = ImageFormSettings;

interface UploadedFile {
  id: string;
  name: string;
  preview: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

interface ImageToImageFormProps {
  wideMode?: boolean;
  onSubmit: (data: {
    prompt: string;
    files: UploadedFile[];
    outputSize: OutputSize;
    customSize?: string;
    temperature: number;
    aspectRatio: AspectRatio;
    model: string;
    gptImageQuality: GptImageQuality;
    gptImageStyle: GptImageStyle;
    gptImageBackground: GptImageBackground;
    parallelCount: ParallelCount;
  }) => void;
  disabled?: boolean;
  onDraftConsumed?: () => void;
  onConfigureApiKey?: () => void;
  initialData?: {
    prompt?: string;
    outputSize?: OutputSize;
    customSize?: string;
    temperature?: number;
    aspectRatio?: AspectRatio;
    model?: ModelId;
    gptImageQuality?: GptImageQuality;
    gptImageStyle?: GptImageStyle;
    gptImageBackground?: GptImageBackground;
    parallelCount?: ParallelCount;
    refImages?: { id: string; name: string; dataUrl: string; mimeType: string }[];
  };
  referenceDraft?: {
    id: number;
    refImages: RefImageData[];
  } | null;
}

export function ImageToImageForm({
  onSubmit,
  disabled = false,
  onDraftConsumed,
  onConfigureApiKey,
  initialData,
  referenceDraft,
}: ImageToImageFormProps) {
  const [prompt, setPrompt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);

  const disabledMessage = '请先在设置中配置 Nova API 密钥，配置完成后即可开始转换图片。';

  // 先使用稳定默认值，避免 SSR/CSR 首帧不一致；挂载后再恢复缓存
  const [model, setModel] = useState<ModelId>('gemini-3-pro-image-preview');
  const [outputSize, setOutputSize] = useState<OutputSize>('1K');
  const [customSize, setCustomSize] = useState<string | undefined>(undefined);
  const [temperature, setTemperature] = useState<number>(1);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [gptImageAdvancedParams, setGptImageAdvancedParams] = useState<GptImageAdvancedParams>(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  const [parallelCount, setParallelCount] = useState<ParallelCount>(1);
  const [settingsReady, setSettingsReady] = useState(false);

  // 根据当前模型限制上传数量
  const modelLimit = MODEL_IMAGE_LIMITS[model] || { max: 1, description: '最多 1 张参考图片' };
  const maxImages = modelLimit.max;

  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [sizePopoverOpen, setSizePopoverOpen] = useState(false);
  const [aspectPopoverOpen, setAspectPopoverOpen] = useState(false);
  const [customSizeDialogOpen, setCustomSizeDialogOpen] = useState(false);
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [parallelPopoverOpen, setParallelPopoverOpen] = useState(false);
  const [temperaturePopoverOpen, setTemperaturePopoverOpen] = useState(false);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [textAssetPickerOpen, setTextAssetPickerOpen] = useState(false);
  const [pendingTextAsset, setPendingTextAsset] = useState<TextAsset | null>(null);

  // 提示词优化
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

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
      { apiKey: textModel.apiKey, model: textModel.id, mode: 'image-to-image', prompt: prompt.trim(), images },
      {
        onDelta(token) { setOptimizedText(prev => prev + token); },
        onDone() { setOptimizing(false); },
        onError(err) { setOptimizeError(err.message); setOptimizing(false); },
      },
      textModel.baseUrl,
    );
    optimizeHandleRef.current = handle;
  }, [prompt, pendingFiles]);

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

  const handleModelChange = (newModel: ModelId) => {
    setModel(newModel);
    setGptImageAdvancedParams(prev => getGptImageAdvancedParamsForModel(newModel, prev));
    const sizeOptions = getSizeOptions(newModel);
    const nextOutputSize = outputSize === 'auto' && supportsAutoLayout(newModel)
      ? 'auto'
      : (sizeOptions.find(s => s.value === outputSize)?.value || sizeOptions[0].value);
    if (nextOutputSize !== outputSize) {
      setOutputSize(nextOutputSize);
    }
    if (supportsCustomSize(newModel)) {
      setCustomSize(prev => normalizeCustomImageSize(prev, getCustomSizeMaxSide(newModel)));
    } else {
      setCustomSize(undefined);
    }
    const aspectOptions = getAspectRatioOptions(newModel, nextOutputSize);
    if (!aspectOptions.find(a => a.value === aspectRatio)) {
      setAspectRatio(aspectOptions[0]?.value || '1:1');
    }
  };

  const handleSizeChange = (newSize: OutputSize) => {
    setOutputSize(newSize);
    setCustomSize(undefined);
    const aspectOptions = getAspectRatioOptions(model, newSize);
    if (!aspectOptions.find(a => a.value === aspectRatio)) {
      setAspectRatio(aspectOptions[0]?.value || '1:1');
    }
    setTimeout(() => setSizePopoverOpen(false), 0);
  };

  const handleAutoLayoutChange = (enabled: boolean) => {
    if (enabled) {
      setOutputSize('auto');
      setAspectRatio('auto');
      setCustomSize(undefined);
      setSizePopoverOpen(false);
      setAspectPopoverOpen(false);
      return;
    }

    setOutputSize('1K');
    setAspectRatio('1:1');
  };

  const handleAspectRatioChange = (newRatio: AspectRatio) => {
    setAspectRatio(newRatio);
    setCustomSize(undefined);
    setTimeout(() => setAspectPopoverOpen(false), 0);
  };

  const handleParallelCountChange = (count: ParallelCount) => {
    setParallelCount(count);
    setTimeout(() => setParallelPopoverOpen(false), 0);
  };

  // 当模型改变时，重置分辨率和比例
  const sizeOptions = getSizeOptions(model);
  const aspectRatioOptions = getAspectRatioOptions(model, outputSize);
  const supportsTemperature = !isGptImageModel(model);
  const supportsAdvancedParams = supportsGptImageAdvancedParams(model);
  const autoLayoutAvailable = supportsAutoLayout(model);
  const autoLayoutLocked = autoLayoutAvailable && outputSize === 'auto';
  const showSizeControl = model !== 'gpt-image-2';
  const customSizeAvailable = supportsCustomSize(model) && !autoLayoutLocked;
  const customSizeMaxSide = getCustomSizeMaxSide(model) || 2048;
  const displaySizeLabel = customSize || getOutputSizeLabel(outputSize);

  // 挂载后恢复缓存设置（仅客户端执行）
  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      const useInitial = initialData ? true : false;

    const saved = loadJsonFromStorage<I2ISettings>(I2I_SETTINGS_KEY);

    const nextModel = normalizeModel(useInitial && initialData?.model ? initialData.model : saved.model);
    const validSizes = getValidOutputSizes(nextModel);
    const nextOutputSize: OutputSize = useInitial && initialData?.outputSize && validSizes.includes(initialData.outputSize)
      ? initialData.outputSize
      : (saved.outputSize && validSizes.includes(saved.outputSize) ? saved.outputSize : validSizes[0]);
    const nextCustomSize = supportsCustomSize(nextModel) && nextOutputSize !== 'auto'
      ? normalizeCustomImageSize(useInitial ? initialData?.customSize : saved.customSize, getCustomSizeMaxSide(nextModel))
      : undefined;
    const validRatios = getAspectRatioOptions(nextModel, nextOutputSize).map(a => a.value);
    const nextAspectRatio: AspectRatio = useInitial && initialData?.aspectRatio && validRatios.includes(initialData.aspectRatio)
      ? initialData.aspectRatio
      : (saved.aspectRatio && validRatios.includes(saved.aspectRatio) ? saved.aspectRatio : (validRatios[0] || '1:1'));
    const nextTemperature = useInitial && typeof initialData?.temperature === 'number' && initialData.temperature >= 0 && initialData.temperature <= 2
      ? initialData.temperature
      : (typeof saved.temperature === 'number' && saved.temperature >= 0 && saved.temperature <= 2 ? saved.temperature : 1);
    const nextAdvancedParams = getGptImageAdvancedParamsForModel(nextModel, {
      quality: useInitial ? initialData?.gptImageQuality : saved.gptImageQuality,
      style: useInitial ? initialData?.gptImageStyle : saved.gptImageStyle,
      background: useInitial ? initialData?.gptImageBackground : saved.gptImageBackground,
    });
    const nextParallelCount: ParallelCount = useInitial && initialData?.parallelCount && [1, 2, 3, 4].includes(initialData.parallelCount)
      ? initialData.parallelCount
      : (saved.parallelCount && [1, 2, 3, 4].includes(saved.parallelCount) ? saved.parallelCount : 1);

    setModel(nextModel);
    setOutputSize(nextOutputSize);
    setCustomSize(nextCustomSize);
    setAspectRatio(nextAspectRatio);
    setTemperature(nextTemperature);
    setGptImageAdvancedParams(nextAdvancedParams);
    setParallelCount(nextParallelCount);
    // 如果有初始数据，填充提示词和参考图
    if (useInitial) {
      if (initialData?.prompt) {
        setPrompt(initialData.prompt);
      }
      if (initialData?.refImages && initialData.refImages.length > 0) {
        // 添加 preview 字段以匹配 UploadedFile 类型
        const filesWithPreview: UploadedFile[] = initialData.refImages.map(img => ({
          ...img,
          preview: img.dataUrl, // 使用 dataUrl 作为 preview
          badge: '已恢复',
        }));
        setPendingFiles(filesWithPreview);
      }
    }

    setSettingsReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [initialData]);

  // 保存设置到缓存
  useEffect(() => {
    if (!settingsReady) return;
    saveJsonToStorage(I2I_SETTINGS_KEY, {
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
  }, [model, outputSize, customSize, aspectRatio, temperature, gptImageAdvancedParams, parallelCount, settingsReady]);

  const handleSubmit = () => {
    if (prompt.trim() && pendingFiles.length > 0) {
      onSubmit({
        prompt: prompt.trim(),
        files: pendingFiles,
        outputSize,
        customSize,
        temperature,
        aspectRatio,
        model,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
      });
      setPendingFiles([]);
      setPrompt('');
      onDraftConsumed?.();
    }
  };

  const handleClearDraft = () => {
    setPrompt('');
    setPendingFiles([]);
    setUploadError(null);
    onDraftConsumed?.();
  };

  const handleRemovePending = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const consumedDraftRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!referenceDraft?.refImages.length) return;
    if (consumedDraftRef.current === referenceDraft.id) return;
    consumedDraftRef.current = referenceDraft.id;
    setPendingFiles(prev => {
      const existingIds = new Set(prev.map(file => file.id));
      const remainingSlots = Math.max(0, maxImages - prev.length);
      if (remainingSlots <= 0) {
        setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} 最多支持 ${maxImages} 张参考图`);
        return prev;
      }
      const incoming: UploadedFile[] = referenceDraft.refImages
        .filter(img => !existingIds.has(img.id))
        .slice(0, remainingSlots)
        .map(img => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '参考',
        }));
      if (incoming.length < referenceDraft.refImages.length) {
        setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} 最多支持 ${maxImages} 张参考图，已添加可容纳的图片`);
      } else {
        setUploadError(null);
      }
      return incoming.length > 0 ? [...prev, ...incoming] : prev;
    });
    onDraftConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- referenceDraft.id is the stable identity; refImages is consumed via ref guard
  }, [maxImages, model, onDraftConsumed, referenceDraft?.id]);

  // 获取图片尺寸并自动检测比例
  const detectImageAspectRatio = useCallback(async (dataUrl: string): Promise<AspectRatio | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const detectedRatio = detectClosestAspectRatio(img.width, img.height, aspectRatioOptions);
        resolve(detectedRatio);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }, [aspectRatioOptions]);

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesToProcess = Array.from(fileList).filter(f => f.type.startsWith('image/'));

    if (filesToProcess.length === 0) {
      setUploadError('请选择图像文件');
      return;
    }

    // 检查图片数量限制
    if (pendingFiles.length + filesToProcess.length > maxImages) {
      const modelLimit = MODEL_IMAGE_LIMITS[model];
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

        // 改为“先压缩再校验”：允许原图超限但压缩后可通过
        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          setUploadError(`文件过大: ${file.name}，压缩后仍超过 10MB`);
          continue;
        }

        // 自动检测第一张图片的比例
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

      // 如果检测到比例且当前没有上传的文件，自动设置比例
      if (firstDetectedRatio && pendingFiles.length === 0) {
        setAspectRatio(firstDetectedRatio);
      }
    } catch {
      setUploadError('文件读取失败');
    } finally {
      setLoading(false);
    }
  }, [pendingFiles.length, maxImages, autoLayoutLocked, model, detectImageAspectRatio]);

  const handleImportAssets = useCallback(async (selectedAssets: ImageAsset[]) => {
    if (selectedAssets.length === 0) return;

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
    if (!prompt.trim()) return;
    try {
      await addTextAsset({
        content: prompt,
        sourceKind: 'image-to-image',
        sourceLabel: '图生图',
      });
      dispatchImageActionToast('提示词素材已保存', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  }, [prompt]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (!disabled && e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [disabled, processFiles]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  };

  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled || loading) return;
      const target = e.target as HTMLElement;
      // 只处理粘贴目标在本表单容器内的事件，避免与其他全局粘贴处理器冲突
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
        processFiles(imageFiles);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [disabled, loading, processFiles]);

  const canSubmit = prompt.trim().length > 0 && pendingFiles.length > 0 && !disabled && !loading;

  return (
    <div ref={formRef} className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-xl shadow-md">
        {disabled ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-4 px-4 py-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Info className="h-5 w-5" />
            </div>
            <div className="max-w-md">
              <p className="text-base font-medium text-foreground">需要先配置令牌</p>
              <p className="mt-2 text-sm text-muted-foreground">{disabledMessage}</p>
            </div>
            <Button onClick={() => setMissingApiKeyDialogOpen(true)}>
              配置
            </Button>
          </div>
        ) : (
          <>
            <div className="p-4">
              <div className="flex gap-3">
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`relative flex-[3] border-2 border-dashed rounded-xl px-6 py-10 text-center transition-all overflow-hidden ${isDragOver
                    ? 'border-primary bg-primary/20'
                    : 'bg-primary/5 border-primary/30 hover:bg-primary/10 hover:border-primary/50 cursor-pointer'
                    }`}
                >
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileSelect}
                    disabled={loading}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed overflow-hidden"
                    style={{ fontSize: 0 }}
                  />
                  <CloudUpload className={`w-6 h-6 mx-auto mb-1 ${isDragOver ? 'text-primary' : 'text-muted-foreground'}`} />
                  <p className="text-sm font-medium">
                    {loading ? '读取中...' : isDragOver ? '将图像拖放到这里' : '拖放图像到此处'}
                  </p>
                  <p className="text-xs text-muted-foreground">点击选择 · 拖放 · Ctrl+V 粘贴</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {pendingFiles.length} / {maxImages} 张
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAssetPickerOpen(true)}
                  disabled={loading || pendingFiles.length >= maxImages}
                  title="从素材库导入参考图"
                  className="flex-1 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-3 py-4 text-center transition-all hover:bg-primary/10 hover:border-primary/50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  <ImagePlus className="h-6 w-6 text-muted-foreground" />
                  <span className="text-sm font-medium">素材库</span>
                  <span className="text-xs text-muted-foreground">导入素材</span>
                </button>
              </div>
            </div>

            {pendingFiles.length > 0 && (
              <div className="px-4 pb-2">
                <AttachmentChips
                  files={pendingFiles}
                  onRemove={handleRemovePending}
                  sourceKind="upload"
                  sourceLabel="图生图参考图"
                  prompt={prompt}
                  showDownload={false}
                  showCopy
                  showUseAsReference={false}
                />
              </div>
            )}

            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述如何转换图像..."
              rows={2}
              className="border-0 bg-transparent resize-none focus-visible:ring-0 focus-visible:border-0 rounded-none px-3 pt-3 sm:px-4 sm:pt-4 placeholder:text-placeholder"
            />

            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-3">
          {/* 模型选择 */}
          <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
            <PopoverTrigger
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="模型选择"
            >
              <Sparkles className="h-3 w-3" />
              <span className="shrink-0 truncate text-[11px]">{MODEL_OPTIONS.find(o => o.value === model)?.label}</span>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {MODEL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    handleModelChange(option.value);
                    setModelPopoverOpen(false);
                  }}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 rounded-md text-sm hover:bg-muted',
                    model === option.value && 'bg-muted font-medium'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {autoLayoutAvailable && (
            <button
              type="button"
              onClick={() => handleAutoLayoutChange(!autoLayoutLocked)}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'xs' }),
                'gap-1',
                autoLayoutLocked && 'border-primary text-primary'
              )}
              title="自动分辨率和比例"
            >
              <span className={cn(
                'flex h-3 w-3 items-center justify-center rounded-[3px] border',
                autoLayoutLocked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'
              )}>
                {autoLayoutLocked && <Check className="h-2.5 w-2.5" />}
              </span>
              <span className="text-[11px]">自动</span>
            </button>
          )}

          {showSizeControl && (
            <Popover open={sizePopoverOpen && !autoLayoutLocked} onOpenChange={(open) => setSizePopoverOpen(autoLayoutLocked ? false : open)}>
              <PopoverTrigger
                className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
                title={autoLayoutLocked ? "自动模式已锁定分辨率" : "输出分辨率"}
                disabled={autoLayoutLocked}
              >
                <Maximize className="h-3 w-3" />
                <span className="text-[11px]">{displaySizeLabel}</span>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                {sizeOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleSizeChange(option.value)}
                    className={cn(
                      'w-full text-left px-2.5 py-1.5 rounded-md text-sm hover:bg-muted',
                      outputSize === option.value && !customSize && 'bg-muted font-medium'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
                {customSizeAvailable && (
                  <button
                    type="button"
                    onClick={() => { setAspectPopoverOpen(false); setCustomSizeDialogOpen(true); }}
                    className={cn(
                      'mt-1 flex w-full items-center gap-1.5 rounded-md border-t px-2.5 py-1.5 text-sm hover:bg-muted',
                      customSize && 'bg-muted font-medium'
                    )}
                  >
                    <Maximize className="h-3.5 w-3.5" />
                    自定义{customSize ? `（${customSize}）` : ''}
                  </button>
                )}
              </PopoverContent>
            </Popover>
          )}

          <Popover open={aspectPopoverOpen && !autoLayoutLocked} onOpenChange={(open) => setAspectPopoverOpen(autoLayoutLocked ? false : open)}>
            <PopoverTrigger
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title={autoLayoutLocked ? "自动模式已锁定比例" : "图像比例"}
              disabled={autoLayoutLocked}
            >
              <RectangleHorizontal className="h-3 w-3" />
              <span className="text-[11px]">{aspectRatio}</span>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="start">
              <div className="grid grid-cols-2 gap-1">
                {aspectRatioOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleAspectRatioChange(option.value)}
                    className={cn(
                      'text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted',
                      aspectRatio === option.value && 'bg-muted font-medium'
                    )}
                  >
                    {option.value}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={parallelPopoverOpen} onOpenChange={setParallelPopoverOpen}>
            <PopoverTrigger
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="并行数量"
            >
              <Copy className="h-3 w-3" />
              <span className="text-[11px]">x{parallelCount}</span>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {[1, 2, 3, 4].map((count) => (
                <button
                  key={count}
                  onClick={() => handleParallelCountChange(count as ParallelCount)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-muted',
                    parallelCount === count && 'bg-muted font-medium'
                  )}
                >
                  生成 {count} 张
                  {parallelCount === count && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {supportsAdvancedParams && (
            <GptImageAdvancedParamsControl
              value={gptImageAdvancedParams}
              onChange={setGptImageAdvancedParams}
              variant="outline"
              size="xs"
            />
          )}

          {supportsTemperature && <Popover open={temperaturePopoverOpen} onOpenChange={setTemperaturePopoverOpen}>
            <PopoverTrigger
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="温度（0=精确，1=均衡，2=创意）"
            >
              <Thermometer className="h-3 w-3" />
              <span className="text-[11px]">{temperature.toFixed(2)}</span>
            </PopoverTrigger>
            <PopoverContent className="w-56" align="start">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">温度</label>
                  <span className="text-sm text-muted-foreground">{temperature.toFixed(2)}</span>
                </div>
                <Slider
                  value={[temperature]}
                  onValueChange={(value) => setTemperature(value[0])}
                  min={0}
                  max={2}
                  step={0.01}
                  className="w-full"
                />
                <div className="flex justify-between gap-2">
                  <Button variant="outline" size="xs" onClick={() => setTemperature(0)} className="flex-1">精确 (0)</Button>
                  <Button variant="outline" size="xs" onClick={() => setTemperature(1)} className="flex-1">均衡 (1)</Button>
                  <Button variant="outline" size="xs" onClick={() => setTemperature(2)} className="flex-1">创意 (2)</Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>}
          </div>

          <div className="ml-auto flex w-full justify-end gap-2 px-4 pb-2 sm:w-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setQuickPromptOpen(true)}
              title="快速提示词"
            >
              <Zap className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTextAssetPickerOpen(true)}
              title="导入提示词素材"
            >
              <FileText className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleSavePromptAsset()}
              disabled={disabled || !prompt.trim()}
              title="存为提示词素材"
            >
              <Save className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleOptimize}
              disabled={disabled || !prompt.trim()}
              title="优化提示词"
            >
              <Sparkles className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={handleClearDraft}
              disabled={disabled || (!prompt.trim() && pendingFiles.length === 0)}
              title="清空提示词和图片"
            >
              <X className="w-5 h-5" />
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={disabled || !canSubmit}
              size="icon"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ArrowUp className="w-5 h-5" />
              )}
            </Button>
          </div>
        </>
        )}
      </div>

      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      <CustomSizeDialog
        open={customSizeDialogOpen}
        value={customSize}
        maxSide={customSizeMaxSide}
        onOpenChange={setCustomSizeDialogOpen}
        onApply={setCustomSize}
      />
      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => onConfigureApiKey?.()}
      />
      <QuickPromptDialog
        open={quickPromptOpen}
        onOpenChange={setQuickPromptOpen}
        currentMode="image-to-image"
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
