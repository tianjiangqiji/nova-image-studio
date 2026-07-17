'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ImagePlus, Layers, Maximize, Pencil, RectangleHorizontal, Sparkles, Thermometer, Wand2, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { CustomSizeDialog } from '@/components/CustomSizeDialog';
import { GptImageAdvancedParamsControl } from '@/components/GptImageAdvancedParamsControl';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  MODEL_OPTIONS,
  type ModelId,
} from '@/lib/gemini-config';
import type { AspectRatio, OutputSize } from '@/lib/job-store';
import {
  findReferenceCapableModel,
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getModelMaxRefImages,
  getOutputSizeLabel,
  getSizeOptions,
  getSupportsTemperature,
  getValidOutputSizes,
  getGptImageAdvancedParamsForModel,
  normalizeCustomImageSize,
  resolveAgentLayout,
  supportsGptImageAdvancedParams,
  supportsAutoLayout,
  supportsCustomSize,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import type { AgentImageRecord, AgentProposal } from '@/lib/agent-chat-config';

export interface AgentApproveParams {
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  parallelCount: ParallelCount;
}

interface AgentProposalCardProps {
  proposal: AgentProposal;
  images: AgentImageRecord[];
  imageModel: ModelId;
  busy?: boolean;
  hideControls?: boolean;
  onModelChange: (model: ModelId) => void;
  onApprove: (prompt: string, selectedImageIds: string[], model: ModelId, params: AgentApproveParams) => void;
  onCancel: () => void;
}

const PARALLEL_OPTIONS: ParallelCount[] = [1, 2, 3, 4];

export function AgentProposalCard({
  proposal,
  images,
  imageModel,
  busy = false,
  hideControls = false,
  onModelChange,
  onApprove,
  onCancel,
}: AgentProposalCardProps) {
  const maxRefs = getModelMaxRefImages(imageModel);
  const [prompt, setPrompt] = useState(proposal.prompt);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    proposal.referencedImageIds.filter(id => images.some(img => img.imgId === id)).slice(0, Math.max(0, maxRefs))
  );
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [sizePopoverOpen, setSizePopoverOpen] = useState(false);
  const [aspectPopoverOpen, setAspectPopoverOpen] = useState(false);
  const [tempPopoverOpen, setTempPopoverOpen] = useState(false);
  const [parallelPopoverOpen, setParallelPopoverOpen] = useState(false);
  const [customSizeDialogOpen, setCustomSizeDialogOpen] = useState(false);

  const imageMap = useMemo(() => new Map(images.map(img => [img.imgId, img])), [images]);

  // 首张选中参考图的真实像素，用于优先级 2（上传图分辨率）
  const firstRefDims = useMemo(() => {
    const firstId = selectedIds[0];
    if (!firstId) return undefined;
    const rec = imageMap.get(firstId);
    return rec?.width && rec?.height ? { width: rec.width, height: rec.height } : undefined;
  }, [selectedIds, imageMap]);

  // 初始布局：按「用户语言 > 上传图分辨率 > Agent 智能」优先级预填并合法化
  const [layout, setLayout] = useState<AgentApproveParams>(() => {
    const resolved = resolveAgentLayout(imageModel, {
      requestedAspectRatio: proposal.requestedAspectRatio,
      suggestedAspectRatio: proposal.suggestedAspectRatio,
      requestedOutputSize: proposal.requestedOutputSize,
      temperature: proposal.temperature,
      parallelCount: proposal.parallelCount,
    }, undefined);
    const advancedParams = getGptImageAdvancedParamsForModel(imageModel, {
      quality: proposal.gptImageQuality,
      style: proposal.gptImageStyle,
      background: proposal.gptImageBackground,
    });
    return {
      ...resolved,
      gptImageQuality: advancedParams.quality,
      gptImageStyle: advancedParams.style,
      gptImageBackground: advancedParams.background,
    };
  });

  // 提案首次出现且尚未手动选过参考图时，用首张参考图维度重算一次预填
  const [initializedWithRef, setInitializedWithRef] = useState(false);
  useEffect(() => {
    if (initializedWithRef || !firstRefDims) return;

    queueMicrotask(() => {
      const resolved = resolveAgentLayout(imageModel, {
        requestedAspectRatio: proposal.requestedAspectRatio,
        suggestedAspectRatio: proposal.suggestedAspectRatio,
        requestedOutputSize: proposal.requestedOutputSize,
        temperature: proposal.temperature,
        parallelCount: proposal.parallelCount,
      }, firstRefDims);
      const advancedParams = getGptImageAdvancedParamsForModel(imageModel, {
        quality: proposal.gptImageQuality,
        style: proposal.gptImageStyle,
        background: proposal.gptImageBackground,
      });
      setLayout(prev => ({
        ...resolved,
        gptImageQuality: advancedParams.quality,
        gptImageStyle: advancedParams.style,
        gptImageBackground: advancedParams.background,
        parallelCount: prev.parallelCount,
      }));
      setInitializedWithRef(true);
    });
  }, [firstRefDims, initializedWithRef, imageModel, proposal]);

  const modelLabel = MODEL_OPTIONS.find(o => o.value === imageModel)?.label || imageModel;

  const effectiveMode = selectedIds.length > 0 ? 'edit' : 'generate';
  const overLimit = selectedIds.length > maxRefs;

  const orderedImages = useMemo(
    () => [...images].sort((a, b) => b.createdAt - a.createdAt),
    [images]
  );

  // 各项控件的显示条件（只渲染该模型支持的项）
  const sizeOptions = getSizeOptions(imageModel);
  const aspectRatioOptions = getAspectRatioOptions(imageModel, layout.outputSize);
  const supportsTemp = getSupportsTemperature(imageModel);
  const supportsAdvancedParams = supportsGptImageAdvancedParams(imageModel);
  const autoLayoutAvailable = supportsAutoLayout(imageModel);
  const autoLayoutLocked = autoLayoutAvailable && layout.outputSize === 'auto';
  const showSizeControl = imageModel !== 'gpt-image-2' && (sizeOptions.length > 1 || autoLayoutAvailable);
  const showAspectControl = !autoLayoutLocked && aspectRatioOptions.length > 0;
  const customSizeAvailable = supportsCustomSize(imageModel) && !autoLayoutLocked;
  const customSizeMaxSide = getCustomSizeMaxSide(imageModel) || 2048;
  const displaySizeLabel = layout.customSize || getOutputSizeLabel(layout.outputSize);
  const currentAspectLabel = aspectRatioOptions.find(o => o.value === layout.aspectRatio)?.resolution
    || (layout.aspectRatio === 'auto' ? '自动' : layout.aspectRatio);
  const advancedParams: GptImageAdvancedParams = {
    quality: layout.gptImageQuality,
    style: layout.gptImageStyle,
    background: layout.gptImageBackground,
  };

  const handleModelChange = (next: ModelId) => {
    onModelChange(next);
    // 重新合法化当前布局：档位 snap、比例 snap、自定义尺寸按支持情况保留/清除
    setLayout((prev) => {
      const validSizes = getValidOutputSizes(next);
      const nextSize: OutputSize = validSizes.includes(prev.outputSize) ? prev.outputSize : validSizes[0];
      const advanced = getGptImageAdvancedParamsForModel(next, {
        quality: prev.gptImageQuality,
        style: prev.gptImageStyle,
        background: prev.gptImageBackground,
      });
      if (nextSize === 'auto') {
        return {
          outputSize: 'auto',
          aspectRatio: 'auto',
          temperature: getSupportsTemperature(next) ? prev.temperature : 1,
          gptImageQuality: advanced.quality,
          gptImageStyle: advanced.style,
          gptImageBackground: advanced.background,
          parallelCount: prev.parallelCount,
        };
      }
      const validRatios = getAspectRatioOptions(next, nextSize).map((o) => o.value);
      const nextRatio: AspectRatio = validRatios.includes(prev.aspectRatio) ? prev.aspectRatio : (validRatios[0] || '1:1');
      const nextCustom = supportsCustomSize(next)
        ? normalizeCustomImageSize(prev.customSize, getCustomSizeMaxSide(next))
        : undefined;
      return {
        outputSize: nextSize,
        customSize: nextCustom,
        aspectRatio: nextRatio,
        temperature: getSupportsTemperature(next) ? prev.temperature : 1,
        gptImageQuality: advanced.quality,
        gptImageStyle: advanced.style,
        gptImageBackground: advanced.background,
        parallelCount: prev.parallelCount,
      };
    });
  };

  const toggleImage = (imgId: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(imgId)) return prev.filter((id) => id !== imgId);
      if (maxRefs <= 0) {
        const switched = findReferenceCapableModel(imageModel);
        if (switched && switched !== imageModel) {
          handleModelChange(switched);
          return [imgId];
        }
        return prev;
      }
      if (prev.length >= maxRefs) return prev;
      return [...prev, imgId];
    });
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp selection when maxRefs constraint changes
    setSelectedIds(prev => prev.length > maxRefs ? prev.slice(0, maxRefs) : prev);
  }, [maxRefs]);

  const handleAutoLayoutToggle = (enabled: boolean) => {
    setSizePopoverOpen(false);
    setAspectPopoverOpen(false);
    if (enabled) {
      setLayout(prev => ({ ...prev, outputSize: 'auto', aspectRatio: 'auto', customSize: undefined }));
      return;
    }
    const fallbackSize: OutputSize = sizeOptions[0]?.value || '1K';
    const ratios = getAspectRatioOptions(imageModel, fallbackSize).map(o => o.value);
    setLayout(prev => ({
      ...prev,
      outputSize: fallbackSize,
      aspectRatio: ratios.includes('1:1') ? '1:1' : (ratios[0] || '1:1'),
      customSize: undefined,
    }));
  };

  const handleSizeChange = (size: OutputSize) => {
    setLayout(prev => {
      const ratios = getAspectRatioOptions(imageModel, size).map(o => o.value);
      const nextRatio: AspectRatio = ratios.includes(prev.aspectRatio) ? prev.aspectRatio : (ratios[0] || '1:1');
      return { ...prev, outputSize: size, aspectRatio: nextRatio, customSize: undefined };
    });
    setTimeout(() => setSizePopoverOpen(false), 0);
  };

  const handleAspectChange = (ratio: AspectRatio) => {
    setLayout(prev => ({ ...prev, aspectRatio: ratio, customSize: undefined }));
    setTimeout(() => setAspectPopoverOpen(false), 0);
  };

  const handleParallelChange = (count: ParallelCount) => {
    setLayout(prev => ({ ...prev, parallelCount: count }));
    setTimeout(() => setParallelPopoverOpen(false), 0);
  };

  const handleApprove = () => {
    if (busy || overLimit) return;
    if (maxRefs <= 0 && selectedIds.length > 0) return;
    onApprove(prompt, selectedIds.slice(0, Math.max(0, maxRefs)), imageModel, layout);
  };

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
            effectiveMode === 'edit' ? 'bg-amber-500/15 text-amber-600' : 'bg-primary/15 text-primary'
          )}>
            {effectiveMode === 'edit' ? <Pencil className="h-3 w-3" /> : <Wand2 className="h-3 w-3" />}
            {effectiveMode === 'edit' ? '编辑图片' : '生成新图'}
          </span>
          <span className="text-xs text-muted-foreground">等待你确认</span>
        </div>
      </div>

      {proposal.reason && (
        <p className="mb-3 text-sm text-foreground/80">{proposal.reason}</p>
      )}

      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">提示词（可编辑）</label>
      <Textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        disabled={busy}
        className="mb-3 min-h-24 text-sm"
        placeholder="描述你想要的画面..."
      />

      {orderedImages.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              参考图片（点击勾选，可全部取消）
            </label>
            <span className={cn('text-xs', overLimit ? 'text-destructive' : 'text-muted-foreground')}>
              已选 {selectedIds.length} / 上限 {maxRefs}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {orderedImages.map(img => {
              const selected = selectedIds.includes(img.imgId);
              const selectedIndex = selected ? selectedIds.indexOf(img.imgId) + 1 : 0;
              return (
                <div
                  key={img.imgId}
                  title={img.description}
                  className={cn(
                    'group relative h-16 w-16 overflow-hidden rounded-lg border-2 transition-all',
                    selected ? 'border-primary ring-2 ring-primary/30' : 'border-border opacity-70 hover:opacity-100'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleImage(img.imgId)}
                    disabled={busy}
                    className="block h-full w-full disabled:cursor-not-allowed"
                  >
                    <img src={img.thumbnail} alt={img.imgId} className="h-full w-full object-cover" />
                    {selected ? (
                      <span className="absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold leading-tight text-primary-foreground shadow-sm">
                        {selectedIndex}
                      </span>
                    ) : (
                      <span className="absolute left-0.5 top-0.5 rounded bg-black/50 px-1 text-[9px] leading-tight text-white/70">
                        {img.imgId}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          {maxRefs <= 0 && selectedIds.length > 0 && (
            <p className="mt-1 text-xs text-destructive">
              当前模型不支持参考图，请切换到支持编辑的模型或取消选择。
            </p>
          )}
          {overLimit && maxRefs > 0 && (
            <p className="mt-1 text-xs text-destructive">
              当前模型最多 {maxRefs} 张参考图，且没有可自动切换的兼容模型，请取消部分选择。
            </p>
          )}
        </div>
      )}

      {!hideControls && (
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
          <PopoverTrigger
            disabled={busy}
            className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
          >
            <ImagePlus className="h-3 w-3" />
            <span className="shrink-0 truncate text-[11px]">{modelLabel}</span>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="start">
            {MODEL_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  handleModelChange(option.value);
                  setModelPopoverOpen(false);
                }}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 rounded-md text-sm hover:bg-muted',
                  imageModel === option.value && 'bg-muted font-medium'
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
            onClick={() => handleAutoLayoutToggle(!autoLayoutLocked)}
            disabled={busy}
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

        {showSizeControl && !autoLayoutLocked && sizeOptions.length > 1 && (
          <Popover open={sizePopoverOpen} onOpenChange={setSizePopoverOpen}>
            <PopoverTrigger
              disabled={busy}
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="清晰度"
            >
              <Sparkles className="h-3 w-3" />
              <span className="text-[11px]">{displaySizeLabel}</span>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start">
              {sizeOptions.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSizeChange(option.value)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-muted',
                    option.value === layout.outputSize && !layout.customSize && 'bg-muted font-medium'
                  )}
                >
                  {option.label}
                  {option.value === layout.outputSize && !layout.customSize && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
              {customSizeAvailable && (
                <button
                  type="button"
                  onClick={() => { setSizePopoverOpen(false); setCustomSizeDialogOpen(true); }}
                  className={cn(
                    'mt-1 flex w-full items-center gap-1.5 rounded-md border-t px-2.5 py-1.5 text-sm hover:bg-muted',
                    layout.customSize && 'bg-muted font-medium'
                  )}
                >
                  <Maximize className="h-3.5 w-3.5" />
                  自定义{layout.customSize ? `（${layout.customSize}）` : ''}
                </button>
              )}
            </PopoverContent>
          </Popover>
        )}

        {showAspectControl && (
          <Popover open={aspectPopoverOpen} onOpenChange={setAspectPopoverOpen}>
            <PopoverTrigger
              disabled={busy || !!layout.customSize}
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="纵横比"
            >
              <RectangleHorizontal className="h-3 w-3" />
              <span className="text-[11px]">{layout.aspectRatio}</span>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="start">
              <div className="grid grid-cols-2 gap-1">
                {aspectRatioOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleAspectChange(option.value)}
                    className={cn(
                      'flex flex-col items-start rounded-md px-2.5 py-1.5 text-sm hover:bg-muted',
                      option.value === layout.aspectRatio && 'bg-muted font-medium'
                    )}
                  >
                    <span>{option.value}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {supportsTemp && (
          <Popover open={tempPopoverOpen} onOpenChange={setTempPopoverOpen}>
            <PopoverTrigger
              disabled={busy}
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
              title="温度"
            >
              <Thermometer className="h-3 w-3" />
              <span className="text-[11px]">{layout.temperature.toFixed(2)}</span>
            </PopoverTrigger>
            <PopoverContent className="w-56" align="start">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">温度</label>
                  <span className="text-sm text-muted-foreground">{layout.temperature.toFixed(2)}</span>
                </div>
                <Slider
                  value={[layout.temperature]}
                  onValueChange={value => setLayout(prev => ({ ...prev, temperature: value[0] }))}
                  min={0}
                  max={2}
                  step={0.01}
                  className="w-full"
                />
                <div className="flex justify-between gap-2">
                  <Button variant="outline" size="xs" onClick={() => setLayout(prev => ({ ...prev, temperature: 0 }))} className="flex-1">精确 (0)</Button>
                  <Button variant="outline" size="xs" onClick={() => setLayout(prev => ({ ...prev, temperature: 1 }))} className="flex-1">均衡 (1)</Button>
                  <Button variant="outline" size="xs" onClick={() => setLayout(prev => ({ ...prev, temperature: 2 }))} className="flex-1">创意 (2)</Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {supportsAdvancedParams && (
          <GptImageAdvancedParamsControl
            value={advancedParams}
            onChange={value => setLayout(prev => ({
              ...prev,
              gptImageQuality: value.quality,
              gptImageStyle: value.style,
              gptImageBackground: value.background,
            }))}
            variant="outline"
            size="xs"
            disabled={busy}
          />
        )}

        <Popover open={parallelPopoverOpen} onOpenChange={setParallelPopoverOpen}>
          <PopoverTrigger
            disabled={busy}
            className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1')}
            title="生成数量"
          >
            <Layers className="h-3 w-3" />
            <span className="text-[11px]">×{layout.parallelCount}</span>
          </PopoverTrigger>
          <PopoverContent className="w-36 p-1" align="start">
            {PARALLEL_OPTIONS.map(count => (
              <button
                key={count}
                type="button"
                onClick={() => handleParallelChange(count)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-muted',
                  count === layout.parallelCount && 'bg-muted font-medium'
                )}
              >
                生成 {count} 张
                {count === layout.parallelCount && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {autoLayoutLocked ? '自动布局' : `${displaySizeLabel} · ${currentAspectLabel}`}
          <span className="ml-2">最多 {maxRefs} 张参考图</span>
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} className="gap-1">
            <X className="h-3.5 w-3.5" />
            取消
          </Button>
          <Button size="sm" onClick={handleApprove} disabled={busy || overLimit || prompt.trim().length === 0} className="gap-1">
            <Check className="h-3.5 w-3.5" />
            {effectiveMode === 'edit' ? '允许并改图' : '允许并生成'}
          </Button>
        </div>
      </div>

      <CustomSizeDialog
        open={customSizeDialogOpen}
        value={layout.customSize}
        maxSide={customSizeMaxSide}
        onOpenChange={setCustomSizeDialogOpen}
        onApply={size => setLayout(prev => ({ ...prev, customSize: size }))}
      />

    </div>
  );
}
