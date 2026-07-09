'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, FileText, Info, Save, Sparkles, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { generateUUID } from '@/lib/uuid';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { QuickPromptDialog } from '@/components/QuickPromptDialog';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { AgentTextAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { GenerationParamsBar, type GenerationParamsValue } from '@/components/GenerationParamsBar';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { addTextAsset, type TextAsset } from '@/lib/asset-store';
import { dispatchImageActionToast } from '@/lib/image-actions';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { type ModelId } from '@/lib/gemini-config';
import {
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getValidOutputSizes,
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  getGptImageAdvancedParamsForModel,
  normalizeCustomImageSize,
  normalizeModel,
  supportsCustomSize,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import type { OutputSize, AspectRatio } from '@/lib/job-store';
import type { ImageFormSettings } from '@/lib/form-settings';

interface QueuedPrompt {
  id: string;
  prompt: string;
}

interface TextToImageFormProps {
  wideMode?: boolean;
  onSubmit: (data: { prompts: string[]; outputSize: OutputSize; customSize?: string; aspectRatio: AspectRatio; temperature: number; model: string; gptImageQuality: GptImageQuality; gptImageStyle: GptImageStyle; gptImageBackground: GptImageBackground; parallelCount: ParallelCount }) => void;
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
    parallelCount?: ParallelCount;
  };
}

const T2I_SETTINGS_KEY = 'nova-t2i-settings';

type T2ISettings = ImageFormSettings;

export function TextToImageForm({ onSubmit, disabled = false, onDraftConsumed, onConfigureApiKey, initialData }: TextToImageFormProps) {
  const [prompt, setPrompt] = useState('');
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);

  const disabledMessage = '请先在设置中配置 Nova API 密钥，配置完成后即可开始生成图片。';

  const [model, setModel] = useState<ModelId>('gemini-3-pro-image-preview');
  const [outputSize, setOutputSize] = useState<OutputSize>('1K');
  const [customSize, setCustomSize] = useState<string | undefined>(undefined);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [temperature, setTemperature] = useState<number>(1);
  const [gptImageAdvancedParams, setGptImageAdvancedParams] = useState<GptImageAdvancedParams>(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  const [parallelCount, setParallelCount] = useState<ParallelCount>(1);
  const [settingsReady, setSettingsReady] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 弹窗开关状态
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
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

    // 清理上一次请求
    optimizeHandleRef.current?.abort();
    setOptimizedText('');
    setOptimizeError(null);
    setOptimizing(true);
    setOptimizeOpen(true);

    const handle = streamPromptOptimize(
      { apiKey: textModel.apiKey, model: textModel.id, mode: 'text-to-image', prompt: prompt.trim() },
      {
        onDelta(token) {
          setOptimizedText(prev => prev + token);
        },
        onDone() {
          setOptimizing(false);
        },
        onError(err) {
          setOptimizeError(err.message);
          setOptimizing(false);
        },
      },
      textModel.baseUrl,
    );
    optimizeHandleRef.current = handle;
  }, [prompt]);

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText('');
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText) {
      setPrompt(optimizedText);
    }
    optimizeHandleRef.current = null;
    setOptimizedText('');
    setOptimizeError(null);
  }, [optimizedText]);

  // 参数条（GenerationParamsBar）回传 patch，合并到本地状态（级联逻辑在参数条内部完成）。
  const handleParamsChange = useCallback((patch: Partial<GenerationParamsValue>) => {
    if (patch.model !== undefined) setModel(patch.model);
    if (patch.outputSize !== undefined) setOutputSize(patch.outputSize);
    if ('customSize' in patch) setCustomSize(patch.customSize);
    if (patch.aspectRatio !== undefined) setAspectRatio(patch.aspectRatio);
    if (patch.temperature !== undefined) setTemperature(patch.temperature);
    if (patch.parallelCount !== undefined) setParallelCount(patch.parallelCount);
    if (patch.gptImageAdvancedParams !== undefined) setGptImageAdvancedParams(patch.gptImageAdvancedParams);
  }, []);

  // 自动调整文本框高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [prompt]);

  useEffect(() => {
    const useInitial = initialData ? true : false;
    const saved = loadJsonFromStorage<T2ISettings>(T2I_SETTINGS_KEY);

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

    queueMicrotask(() => {
      setModel(nextModel);
      setOutputSize(nextOutputSize);
      setCustomSize(nextCustomSize);
      setAspectRatio(nextAspectRatio);
      setTemperature(nextTemperature);
      setGptImageAdvancedParams(nextAdvancedParams);
      setParallelCount(nextParallelCount);
      if (useInitial && initialData?.prompt) {
        setPrompt(initialData.prompt);
      }

      setSettingsReady(true);
    });
  }, [initialData]);

  // 保存设置到缓存
  useEffect(() => {
    if (!settingsReady) return;
    saveJsonToStorage(T2I_SETTINGS_KEY, {
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

  const removeFromQueue = (id: string) => {
    setQueue(queue.filter((item) => item.id !== id));
  };

  const handleSubmit = () => {
    const finalQueue = prompt.trim()
      ? [...queue, { id: generateUUID(), prompt: prompt.trim() }]
      : queue;

    if (finalQueue.length > 0) {
      onSubmit({
        prompts: finalQueue.map((item) => item.prompt),
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        model,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
      });
      setQueue([]);
      setPrompt('');
      onDraftConsumed?.();
    }
  };

  const handleClearDraft = () => {
    setPrompt('');
    setQueue([]);
    onDraftConsumed?.();
  };

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
        sourceKind: 'text-to-image',
        sourceLabel: '文生图',
      });
      dispatchImageActionToast('提示词素材已保存', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  }, [prompt]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit = prompt.trim() || queue.length > 0;
  const canClear = prompt.trim().length > 0 || queue.length > 0;

  return (
    <div className="space-y-3">
      {queue.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">队列 ({queue.length})</span>
            <Button variant="ghost" size="xs" onClick={() => setQueue([])}>清空</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {queue.map((item) => (
              <Badge key={item.id} variant="secondary" className="px-3 py-1.5 gap-2 max-w-[240px]">
                <span className="truncate">{item.prompt}</span>
                <button
                  onClick={() => removeFromQueue(item.id)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}

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
            <Button onClick={() => setMissingApiKeyDialogOpen(true)}>
              配置
            </Button>
          </div>
        ) : (
          <>
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述你想要生成的图像..."
              rows={3}
              className="border-0 bg-transparent resize-none focus-visible:ring-0 focus-visible:border-0 px-3 pt-3 sm:px-4 sm:pt-4 placeholder:text-placeholder"
            />

            <div className="px-3 pt-2 pb-2 sm:px-4">
              <GenerationParamsBar
                value={{ model, outputSize, customSize, aspectRatio, temperature, parallelCount, gptImageAdvancedParams }}
                onChange={handleParamsChange}
              />
            </div>

          <div className="ml-auto flex w-full justify-end gap-2 px-3 pb-2 sm:w-auto sm:px-4">
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
              disabled={disabled || !canClear}
              title="清空提示词"
            >
              <X className="w-5 h-5" />
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={disabled || !canSubmit}
              size="icon"
            >
              <ArrowUp className="w-5 h-5" />
            </Button>
          </div>
        </>
        )}
      </div>
      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => onConfigureApiKey?.()}
      />
      <QuickPromptDialog
        open={quickPromptOpen}
        onOpenChange={setQuickPromptOpen}
        currentMode="text-to-image"
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
