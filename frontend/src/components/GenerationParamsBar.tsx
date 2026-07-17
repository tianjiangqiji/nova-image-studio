'use client';

import { useState } from 'react';
import { Check, Copy, Maximize, RectangleHorizontal, Sparkles, Thermometer } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CustomSizeDialog } from '@/components/CustomSizeDialog';
import { GptImageAdvancedParamsControl } from '@/components/GptImageAdvancedParamsControl';
import { cn } from '@/lib/utils';
import { MODEL_OPTIONS, type ModelId } from '@/lib/gemini-config';
import {
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getGptImageAdvancedParamsForModel,
  getOutputSizeLabel,
  getSizeOptions,
  getSupportsTemperature,
  normalizeCustomImageSize,
  supportsAutoLayout,
  supportsCustomSize,
  supportsGptImageAdvancedParams,
  type GptImageAdvancedParams,
  type ParallelCount,
} from '@/lib/model-capabilities';
import type { OutputSize, AspectRatio } from '@/lib/job-store';

export type GenerationParamsValue = {
  model: ModelId;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  parallelCount: ParallelCount;
  gptImageAdvancedParams: GptImageAdvancedParams;
};

type ButtonSize = 'xs' | 'sm';

interface GenerationParamsBarProps {
  value: GenerationParamsValue;
  onChange: (patch: Partial<GenerationParamsValue>) => void;
  size?: ButtonSize;
  className?: string;
}

/**
 * 共享的「模型 + 生成参数」控件条（自宿主 TextToImageForm 抽取）。受控：对外只发最终 patch，
 * 模型/分辨率联动级联在内部完成。文生图与无限画布编排节点共用，保证展示一致并支持自定义分辨率。
 */
export function GenerationParamsBar({ value, onChange, size = 'xs', className }: GenerationParamsBarProps) {
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [sizePopoverOpen, setSizePopoverOpen] = useState(false);
  const [aspectPopoverOpen, setAspectPopoverOpen] = useState(false);
  const [parallelPopoverOpen, setParallelPopoverOpen] = useState(false);
  const [temperaturePopoverOpen, setTemperaturePopoverOpen] = useState(false);
  const [customSizeDialogOpen, setCustomSizeDialogOpen] = useState(false);

  const model = value.model;
  const sizeOptions = getSizeOptions(model);
  const aspectRatioOptions = getAspectRatioOptions(model, value.outputSize);
  const supportsTemperature = getSupportsTemperature(model);
  const supportsAdvancedParams = supportsGptImageAdvancedParams(model);
  const autoLayoutAvailable = supportsAutoLayout(model);
  const autoLayoutLocked = autoLayoutAvailable && value.outputSize === 'auto';
  const showSizeControl = model !== 'gpt-image-2';
  const customSizeAvailable = supportsCustomSize(model) && !autoLayoutLocked;
  const customSizeMaxSide = getCustomSizeMaxSide(model) || 2048;
  const displaySizeLabel = value.customSize || getOutputSizeLabel(value.outputSize);
  const handleModelChange = (newModel: ModelId) => {
    const nextGpt = getGptImageAdvancedParamsForModel(newModel, value.gptImageAdvancedParams);
    const nextSizeOptions = getSizeOptions(newModel);
    const nextOutputSize: OutputSize = value.outputSize === 'auto' && supportsAutoLayout(newModel) ? 'auto' : (nextSizeOptions.find(s => s.value === value.outputSize)?.value || nextSizeOptions[0].value);
    const nextCustomSize = supportsCustomSize(newModel) ? normalizeCustomImageSize(value.customSize, getCustomSizeMaxSide(newModel)) : undefined;
    const aspectOptions = getAspectRatioOptions(newModel, nextOutputSize);
    const nextAspectRatio: AspectRatio = aspectOptions.find(a => a.value === value.aspectRatio) ? value.aspectRatio : (aspectOptions[0]?.value || '1:1');
    onChange({ model: newModel, outputSize: nextOutputSize, customSize: nextCustomSize, aspectRatio: nextAspectRatio, gptImageAdvancedParams: nextGpt });
  };

  const handleSizeChange = (newSize: OutputSize) => {
    const aspectOptions = getAspectRatioOptions(model, newSize);
    const nextAspectRatio: AspectRatio = aspectOptions.find(a => a.value === value.aspectRatio) ? value.aspectRatio : (aspectOptions[0]?.value || '1:1');
    onChange({ outputSize: newSize, customSize: undefined, aspectRatio: nextAspectRatio });
    setTimeout(() => setSizePopoverOpen(false), 0);
  };

  const handleAutoLayoutChange = (enabled: boolean) => {
    if (enabled) {
      onChange({ outputSize: 'auto', aspectRatio: 'auto', customSize: undefined });
      setSizePopoverOpen(false);
      setAspectPopoverOpen(false);
      return;
    }
    onChange({ outputSize: '1K', aspectRatio: '1:1' });
  };

  const handleAspectRatioChange = (newRatio: AspectRatio) => {
    onChange({ aspectRatio: newRatio, customSize: undefined });
    setTimeout(() => setAspectPopoverOpen(false), 0);
  };

  const handleParallelCountChange = (count: ParallelCount) => {
    onChange({ parallelCount: count });
    setTimeout(() => setParallelPopoverOpen(false), 0);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {/* 模型选择 */}
      <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
        <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title="模型选择">
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
              className={cn('w-full text-left px-2.5 py-1.5 rounded-md text-sm hover:bg-muted', model === option.value && 'bg-muted font-medium')}
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
          className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1', autoLayoutLocked && 'border-primary text-primary')}
          title="自动分辨率和比例"
        >
          <span className={cn('flex h-3 w-3 items-center justify-center rounded-[3px] border', autoLayoutLocked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50')}>
            {autoLayoutLocked && <Check className="h-2.5 w-2.5" />}
          </span>
          <span className="text-[11px]">自动</span>
        </button>
      )}

      {showSizeControl && (
        <Popover open={sizePopoverOpen && !autoLayoutLocked} onOpenChange={(open) => setSizePopoverOpen(autoLayoutLocked ? false : open)}>
          <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title={autoLayoutLocked ? '自动模式已锁定分辨率' : '输出分辨率'} disabled={autoLayoutLocked}>
            <Maximize className="h-3 w-3" />
            <span className="text-[11px]">{displaySizeLabel}</span>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="start">
            {sizeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => handleSizeChange(option.value)}
                className={cn('w-full text-left px-2.5 py-1.5 rounded-md text-sm hover:bg-muted', value.outputSize === option.value && !value.customSize && 'bg-muted font-medium')}
              >
                {option.label}
              </button>
            ))}
            {customSizeAvailable && (
              <button
                type="button"
                onClick={() => { setAspectPopoverOpen(false); setCustomSizeDialogOpen(true); }}
                className={cn('mt-1 flex w-full items-center gap-1.5 rounded-md border-t px-2.5 py-1.5 text-sm hover:bg-muted', value.customSize && 'bg-muted font-medium')}
              >
                <Maximize className="h-3.5 w-3.5" />
                自定义{value.customSize ? `（${value.customSize}）` : ''}
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}

      <Popover open={aspectPopoverOpen && !autoLayoutLocked} onOpenChange={(open) => setAspectPopoverOpen(autoLayoutLocked ? false : open)}>
        <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title={autoLayoutLocked ? '自动模式已锁定比例' : '图像比例'} disabled={autoLayoutLocked}>
          <RectangleHorizontal className="h-3 w-3" />
          <span className="text-[11px]">{value.aspectRatio}</span>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-1" align="start">
          <div className="grid grid-cols-2 gap-1">
            {aspectRatioOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => handleAspectRatioChange(option.value)}
                className={cn('text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted', value.aspectRatio === option.value && 'bg-muted font-medium')}
              >
                {option.value}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={parallelPopoverOpen} onOpenChange={setParallelPopoverOpen}>
        <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title="并行数量">
          <Copy className="h-3 w-3" />
          <span className="text-[11px]">x{value.parallelCount}</span>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          {[1, 2, 3, 4].map((count) => (
            <button
              key={count}
              onClick={() => handleParallelCountChange(count as ParallelCount)}
              className={cn('flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-muted', value.parallelCount === count && 'bg-muted font-medium')}
            >
              生成 {count} 张
              {value.parallelCount === count && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {supportsAdvancedParams && (
        <GptImageAdvancedParamsControl value={value.gptImageAdvancedParams} onChange={(next) => onChange({ gptImageAdvancedParams: next })} variant="outline" size={size} />
      )}

      {supportsTemperature && (
        <Popover open={temperaturePopoverOpen} onOpenChange={setTemperaturePopoverOpen}>
          <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size }), 'gap-1')} title="温度（0=精确，1=均衡，2=创意）">
            <Thermometer className="h-3 w-3" />
            <span className="text-[11px]">{value.temperature.toFixed(2)}</span>
          </PopoverTrigger>
          <PopoverContent className="w-56" align="start">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">温度</label>
                <span className="text-sm text-muted-foreground">{value.temperature.toFixed(2)}</span>
              </div>
              <Slider value={[value.temperature]} onValueChange={(v) => onChange({ temperature: v[0] })} min={0} max={2} step={0.01} className="w-full" />
              <div className="flex justify-between gap-2">
                <Button variant="outline" size="xs" onClick={() => onChange({ temperature: 0 })} className="flex-1">精确 (0)</Button>
                <Button variant="outline" size="xs" onClick={() => onChange({ temperature: 1 })} className="flex-1">均衡 (1)</Button>
                <Button variant="outline" size="xs" onClick={() => onChange({ temperature: 2 })} className="flex-1">创意 (2)</Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}

      <CustomSizeDialog open={customSizeDialogOpen} value={value.customSize} maxSide={customSizeMaxSide} onOpenChange={setCustomSizeDialogOpen} onApply={(cs) => onChange({ customSize: cs })} />
    </div>
  );
}
