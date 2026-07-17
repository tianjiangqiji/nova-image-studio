import {
  BUILTIN_IMAGE_PRESETS,
  getCompleteImageModels,
  getImageModelOutputSizes,
  loadRegistry,
  type BuiltinImagePresetId,
  type ImageModelConfig,
} from '@/lib/nova-models';

export type OutputSize = 'auto' | '512' | '1K' | '2K' | '4K';
export type AspectRatio = 'auto' | '1:1' | '1:4' | '1:8' | '2:3' | '3:2' | '3:4' | '4:1' | '4:3' | '4:5' | '5:4' | '8:1' | '9:16' | '16:9' | '21:9';
export type ModelId = string;

export interface ModelOption {
  value: string;
  label: string;
}

export interface ModelImageLimit {
  max: number;
  description: string;
}

function replaceArray<T>(target: T[], next: T[]) {
  target.splice(0, target.length, ...next);
}

function replaceRecord<T>(target: Record<string, T>, next: Record<string, T>) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
}

function getRegistryImageModels(): ImageModelConfig[] {
  return getCompleteImageModels(loadRegistry());
}

export function getModelOptions(): ModelOption[] {
  return getRegistryImageModels().map((model) => ({
    value: model.id,
    label: model.name,
  }));
}

export const MODEL_OPTIONS: ModelOption[] = [];

function getBuiltinPresetId(modelId: string): BuiltinImagePresetId | undefined {
  const registryModel = getRegistryImageModels().find((item) => item.id === modelId);
  return registryModel?.builtinPreset;
}

export function isGptImageModel(modelId: string): boolean {
  const presetId = getBuiltinPresetId(modelId) || modelId;
  return String(presetId).startsWith('gpt-image-2');
}

export function getModelImageLimits(): Record<string, ModelImageLimit> {
  const entries = getRegistryImageModels().map((model) => ([
    model.id,
    {
      max: model.maxRefImages,
      description: model.maxRefImages <= 0
        ? '当前模型不支持参考图'
        : `最多 ${model.maxRefImages} 张参考图片`,
    },
  ] as const));
  return Object.fromEntries(entries);
}

export const MODEL_IMAGE_LIMITS: Record<string, ModelImageLimit> = {};

export function supportsTokenMode(_modelId: string): boolean {
  return false;
}

export function stripTokenSuffix(modelId: string): string {
  return modelId;
}

export function isTokenModel(modelId: string): boolean {
  return false;
}

export function getTokenModelId(modelId: string): string {
  return modelId;
}

export function getBaseModelId(modelId: string): ModelId {
  return modelId;
}

export function getDefaultModelId(): string {
  return loadRegistry().defaults.textToImage;
}

export function getMaxOutputSizesByModel(): Record<string, OutputSize[]> {
  const result: Record<string, OutputSize[]> = {};
  for (const model of getRegistryImageModels()) {
    result[model.id] = getImageModelOutputSizes(model);
  }
  return result;
}

export function getBuiltinPreset(modelId: string) {
  const presetId = getBuiltinPresetId(modelId);
  return presetId ? BUILTIN_IMAGE_PRESETS[presetId] : undefined;
}

export function syncDynamicModelExports(): void {
  replaceArray(MODEL_OPTIONS, getModelOptions());
  replaceRecord(MODEL_IMAGE_LIMITS, getModelImageLimits());
}

syncDynamicModelExports();
