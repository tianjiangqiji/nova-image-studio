import {
  getBuiltinPreset,
  getDefaultModelId,
  getModelImageLimits,
  getModelOptions,
  isGptImageModel,
  type ModelId,
} from '@/lib/gemini-config';
import { getImageModelById, loadRegistry } from '@/lib/nova-models';
import type { AspectRatio, OutputSize, RefImageData, StoredJob } from '@/lib/job-store';

export type ParallelCount = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const PARALLEL_COUNT_VALUES: ParallelCount[] = [1, 2, 3, 4, 5, 6, 7, 8];
type FixedOutputSize = Exclude<OutputSize, 'auto'>;

export type GptImageQuality = 'auto' | 'high' | 'medium' | 'low';
export type GptImageStyle = 'auto' | 'vivid' | 'natural';
export type GptImageBackground = 'auto' | 'transparent' | 'opaque';

export interface GptImageAdvancedParams {
  quality: GptImageQuality;
  style: GptImageStyle;
  background: GptImageBackground;
}

export const DEFAULT_GPT_IMAGE_ADVANCED_PARAMS: GptImageAdvancedParams = {
  quality: 'auto',
  style: 'auto',
  background: 'auto',
};

function getModelConfig(modelId: string) {
  return getImageModelById(loadRegistry(), modelId);
}

function getBuiltinPresetId(modelId: string): string {
  return getModelConfig(modelId)?.builtinPreset || modelId;
}

export const GPT_IMAGE_QUALITY_OPTIONS: { value: GptImageQuality; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];

export const GPT_IMAGE_STYLE_OPTIONS: { value: GptImageStyle; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'vivid', label: '鲜明' },
  { value: 'natural', label: '自然' },
];

export const GPT_IMAGE_BACKGROUND_OPTIONS: { value: GptImageBackground; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'transparent', label: '透明' },
  { value: 'opaque', label: '不透明' },
];

const BANANA_ASPECT_RATIOS: { value: AspectRatio; label: string; resolution: string }[] = [
  { value: '1:1', label: '正方形', resolution: '1024x1024' },
  { value: '2:3', label: '竖向', resolution: '832x1248' },
  { value: '3:2', label: '横向', resolution: '1248x832' },
  { value: '3:4', label: '竖向', resolution: '864x1184' },
  { value: '4:3', label: '横向', resolution: '1184x864' },
  { value: '4:5', label: '竖向', resolution: '896x1152' },
  { value: '5:4', label: '横向', resolution: '1152x896' },
  { value: '9:16', label: '竖屏', resolution: '768x1344' },
  { value: '16:9', label: '宽屏', resolution: '1344x768' },
  { value: '21:9', label: '超宽屏', resolution: '1536x672' },
];

const BANANA_PRO_ASPECT_RATIOS: { value: AspectRatio; label: string; resolutions: Record<FixedOutputSize, string> }[] = [
  { value: '1:1', label: '正方形', resolutions: { '512': '', '1K': '1024x1024', '2K': '2048x2048', '4K': '4096x4096' } },
  { value: '2:3', label: '竖向', resolutions: { '512': '', '1K': '848x1264', '2K': '1696x2528', '4K': '3392x5056' } },
  { value: '3:2', label: '横向', resolutions: { '512': '', '1K': '1264x848', '2K': '2528x1696', '4K': '5056x3392' } },
  { value: '3:4', label: '竖向', resolutions: { '512': '', '1K': '896x1200', '2K': '1792x2400', '4K': '3584x4800' } },
  { value: '4:3', label: '横向', resolutions: { '512': '', '1K': '1200x896', '2K': '2400x1792', '4K': '4800x3584' } },
  { value: '4:5', label: '竖向', resolutions: { '512': '', '1K': '928x1152', '2K': '1856x2304', '4K': '3712x4608' } },
  { value: '5:4', label: '横向', resolutions: { '512': '', '1K': '1152x928', '2K': '2304x1856', '4K': '4608x3712' } },
  { value: '9:16', label: '竖屏', resolutions: { '512': '', '1K': '768x1376', '2K': '1536x2752', '4K': '3072x5504' } },
  { value: '16:9', label: '宽屏', resolutions: { '512': '', '1K': '1376x768', '2K': '2752x1536', '4K': '5504x3072' } },
  { value: '21:9', label: '超宽屏', resolutions: { '512': '', '1K': '1584x672', '2K': '3168x1344', '4K': '6336x2688' } },
];

const GPT_IMAGE_ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: '1:1', label: '正方形' },
  { value: '3:2', label: '横向' },
  { value: '2:3', label: '竖向' },
  { value: '16:9', label: '宽屏' },
  { value: '9:16', label: '竖屏' },
  { value: '4:3', label: '横向' },
  { value: '3:4', label: '竖向' },
  { value: '21:9', label: '超宽屏' },
];

const GROK_IMAGE_ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: '1:1', label: '正方形' },
  { value: '2:3', label: '竖向' },
  { value: '3:2', label: '横向' },
  { value: '3:4', label: '竖向' },
  { value: '4:3', label: '横向' },
  { value: '9:16', label: '竖屏' },
  { value: '16:9', label: '宽屏' },
  { value: '21:9', label: '超宽屏' },
];

function isGrokImagePreset(presetId: string): boolean {
  return presetId === 'grok-imagine-image'
    || presetId === 'grok-imagine-image-quality'
    || presetId === 'grok-imagine-image-edit';
}

function isSeedreamPreset(presetId: string): boolean {
  return presetId === 'doubao-seedream';
}

function normalizeSeedreamOutputSize(outputSize: OutputSize): '2K' | '4K' {
  return outputSize === '4K' ? '4K' : '2K';
}

const SEEDREAM_MIN_OUTPUT_PIXELS = 3686400;
const SEEDREAM_MAX_OUTPUT_PIXELS = 4096 * 4096;
const SEEDREAM_SIZE_MULTIPLE = 16;

export const CUSTOM_IMAGE_SIZE_LIMITS = {
  multiple: 16,
  maxAspectRatio: 3,
  minPixels: 655360,
  maxPixels: 8294400,
} as const;

const BANANA2_ASPECT_RATIOS: { value: AspectRatio; label: string; resolutions: Record<FixedOutputSize, string> }[] = [
  { value: '1:1', label: '正方形', resolutions: { '512': '512x512', '1K': '1024x1024', '2K': '2048x2048', '4K': '4096x4096' } },
  { value: '1:4', label: '竖向', resolutions: { '512': '256x1024', '1K': '512x2048', '2K': '1024x4096', '4K': '2048x8192' } },
  { value: '1:8', label: '竖向', resolutions: { '512': '192x1536', '1K': '384x3072', '2K': '768x6144', '4K': '1536x12288' } },
  { value: '2:3', label: '竖向', resolutions: { '512': '424x632', '1K': '848x1264', '2K': '1696x2528', '4K': '3392x5056' } },
  { value: '3:2', label: '横向', resolutions: { '512': '632x424', '1K': '1264x848', '2K': '2528x1696', '4K': '5056x3392' } },
  { value: '3:4', label: '竖向', resolutions: { '512': '448x600', '1K': '896x1200', '2K': '1792x2400', '4K': '3584x4800' } },
  { value: '4:1', label: '横向', resolutions: { '512': '1024x256', '1K': '2048x512', '2K': '4096x1024', '4K': '8192x2048' } },
  { value: '4:3', label: '横向', resolutions: { '512': '600x448', '1K': '1200x896', '2K': '2400x1792', '4K': '4800x3584' } },
  { value: '4:5', label: '竖向', resolutions: { '512': '464x576', '1K': '928x1152', '2K': '1856x2304', '4K': '3712x4608' } },
  { value: '5:4', label: '横向', resolutions: { '512': '576x464', '1K': '1152x928', '2K': '2304x1856', '4K': '4608x3712' } },
  { value: '8:1', label: '横向', resolutions: { '512': '1536x192', '1K': '3072x384', '2K': '6144x768', '4K': '12288x1536' } },
  { value: '9:16', label: '竖屏', resolutions: { '512': '384x688', '1K': '768x1376', '2K': '1536x2752', '4K': '3072x5504' } },
  { value: '16:9', label: '宽屏', resolutions: { '512': '688x384', '1K': '1376x768', '2K': '2752x1536', '4K': '5504x3072' } },
  { value: '21:9', label: '超宽屏', resolutions: { '512': '792x168', '1K': '1584x672', '2K': '3168x1344', '4K': '6336x2688' } },
];

export interface AspectRatioOption {
  value: AspectRatio;
  label: string;
  resolution: string;
}

export interface RetryData {
  mode: StoredJob['mode'];
  prompt: string;
  outputSize: OutputSize;
  temperature: number;
  aspectRatio: AspectRatio;
  customSize?: string;
  model: ModelId;
  parallelCount: ParallelCount;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  refImages?: RefImageData[];
}

function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function parseImageSize(size?: string): { width: number; height: number } | undefined {
  const match = String(size || '').match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
  if (!match) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function isImageSizeWithinLimits(width: number, height: number, maxSide?: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const pixels = width * height;

  return (
    longSide <= limit &&
    width % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 &&
    height % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 &&
    longSide / shortSide <= CUSTOM_IMAGE_SIZE_LIMITS.maxAspectRatio &&
    pixels >= CUSTOM_IMAGE_SIZE_LIMITS.minPixels &&
    pixels <= CUSTOM_IMAGE_SIZE_LIMITS.maxPixels
  );
}

function isGptImage2ProResolutionSupported(size?: string): boolean {
  const parsed = parseImageSize(size);
  return Boolean(parsed && isImageSizeWithinLimits(parsed.width, parsed.height, getCustomSizeMaxSide('gpt-image-2')));
}

export function getGptImageResolution(outputSize: OutputSize, aspectRatio: AspectRatio): string | undefined {
  if (outputSize === 'auto' || outputSize === '512' || aspectRatio === 'auto') return undefined;

  const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
  if (!ratioWidth || !ratioHeight) return undefined;

  if (ratioWidth === ratioHeight) {
    const side = outputSize === '1K' ? 1024 : outputSize === '2K' ? 2048 : 3840;
    return `${side}x${side}`;
  }

  if (outputSize === '1K') {
    const shortSide = 1024;
    const width = ratioWidth > ratioHeight
      ? roundToMultiple(shortSide * ratioWidth / ratioHeight, 16)
      : shortSide;
    const height = ratioWidth > ratioHeight
      ? shortSide
      : roundToMultiple(shortSide * ratioHeight / ratioWidth, 16);
    return `${width}x${height}`;
  }

  const longSide = outputSize === '2K' ? 2048 : 3840;
  const width = ratioWidth > ratioHeight
    ? longSide
    : roundToMultiple(longSide * ratioWidth / ratioHeight, 16);
  const height = ratioWidth > ratioHeight
    ? roundToMultiple(longSide * ratioHeight / ratioWidth, 16)
    : longSide;
  return `${width}x${height}`;
}

function clampSeedreamImageSize(size?: string): string | undefined {
  const parsed = parseImageSize(size);
  if (!parsed) return undefined;

  const pixels = parsed.width * parsed.height;
  if (pixels >= SEEDREAM_MIN_OUTPUT_PIXELS && pixels <= SEEDREAM_MAX_OUTPUT_PIXELS) {
    return `${parsed.width}x${parsed.height}`;
  }

  const scale = Math.sqrt((pixels < SEEDREAM_MIN_OUTPUT_PIXELS
    ? SEEDREAM_MIN_OUTPUT_PIXELS
    : SEEDREAM_MAX_OUTPUT_PIXELS) / pixels);
  const align = pixels < SEEDREAM_MIN_OUTPUT_PIXELS
    ? (value: number) => Math.ceil(value / SEEDREAM_SIZE_MULTIPLE) * SEEDREAM_SIZE_MULTIPLE
    : (value: number) => Math.max(SEEDREAM_SIZE_MULTIPLE, Math.floor(value / SEEDREAM_SIZE_MULTIPLE) * SEEDREAM_SIZE_MULTIPLE);

  return `${align(parsed.width * scale)}x${align(parsed.height * scale)}`;
}

function getSeedreamResolution(outputSize: OutputSize, aspectRatio: AspectRatio): string {
  const legalSize = normalizeSeedreamOutputSize(outputSize);
  return clampSeedreamImageSize(getGptImageResolution(legalSize, aspectRatio)) || legalSize;
}

export function normalizeCustomImageSize(size?: string, maxSide?: number): string | undefined {
  const parsed = parseImageSize(size);
  if (!parsed) return undefined;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const width = Math.min(roundToMultiple(parsed.width, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  const height = Math.min(roundToMultiple(parsed.height, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  if (!isImageSizeWithinLimits(width, height, maxSide)) return undefined;

  return `${width}x${height}`;
}

function isAntigravityGeminiModel(model: ModelId, modelConfig = getModelConfig(model)): boolean {
  const presetId = modelConfig?.builtinPreset || model;
  if (presetId === 'antigravity-gemini-image') return true;
  const upstreamId = String(modelConfig?.modelId || '').toLowerCase();
  return modelConfig?.protocol === 'openai'
    && upstreamId.includes('gemini')
    && upstreamId.includes('image');
}

export function getCustomSizeMaxSide(model: ModelId): number | undefined {
  const modelConfig = getModelConfig(model);
  if (!modelConfig || isAntigravityGeminiModel(model, modelConfig)) return undefined;
  return modelConfig.protocol === 'openai' && modelConfig.maxOutputSize === '4K' ? 3840 : undefined;
}

export function supportsCustomSize(model: ModelId): boolean {
  return Boolean(getCustomSizeMaxSide(model));
}

export function supportsAutoLayout(model: ModelId): boolean {
  const modelConfig = getModelConfig(model);
  if (isAntigravityGeminiModel(model, modelConfig)) return false;
  const presetId = getBuiltinPresetId(model);
  if (isGrokImagePreset(presetId) || isSeedreamPreset(presetId)) return false;
  if (String(presetId).startsWith('gemini') || String(presetId).startsWith('alibaba')) return false;
  const upstreamId = String(modelConfig?.modelId || model).toLowerCase();
  if (upstreamId.includes('gemini') && upstreamId.includes('image')) return false;
  if (upstreamId.includes('grok-imagine')) return false;
  return String(presetId).startsWith('gpt-image-2');
}

export function supportsGptImageAdvancedParams(model: string): boolean {
  const modelConfig = getModelConfig(model);
  if (modelConfig) return Boolean(modelConfig.supportsAdvancedParams);
  const preset = getBuiltinPreset(model);
  return Boolean(preset?.supportsAdvancedParams);
}

export function normalizeGptImageQuality(value?: string): GptImageQuality {
  return GPT_IMAGE_QUALITY_OPTIONS.some(option => option.value === value)
    ? (value as GptImageQuality)
    : DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality;
}

export function normalizeGptImageStyle(value?: string): GptImageStyle {
  return GPT_IMAGE_STYLE_OPTIONS.some(option => option.value === value)
    ? (value as GptImageStyle)
    : DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style;
}

export function normalizeGptImageBackground(value?: string): GptImageBackground {
  return GPT_IMAGE_BACKGROUND_OPTIONS.some(option => option.value === value)
    ? (value as GptImageBackground)
    : DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background;
}

export function getGptImageAdvancedParamsForModel(
  model: string,
  params?: Partial<GptImageAdvancedParams>,
): GptImageAdvancedParams {
  if (!supportsGptImageAdvancedParams(model)) {
    return DEFAULT_GPT_IMAGE_ADVANCED_PARAMS;
  }

  return {
    quality: normalizeGptImageQuality(params?.quality),
    style: normalizeGptImageStyle(params?.style),
    background: normalizeGptImageBackground(params?.background),
  };
}

export function getSizeOptions(model: ModelId): { value: OutputSize; label: string }[] {
  const modelConfig = getModelConfig(model);
  if (modelConfig) {
    if (isSeedreamPreset(modelConfig.builtinPreset)) {
      const values: OutputSize[] = modelConfig.maxOutputSize === '4K' ? ['2K', '4K'] : ['2K'];
      return values.map(value => ({ value, label: value }));
    }
    if (isGrokImagePreset(modelConfig.builtinPreset)) {
      const values: OutputSize[] = modelConfig.maxOutputSize === '2K' || modelConfig.maxOutputSize === '4K'
        ? ['1K', '2K']
        : ['1K'];
      return values.map((value) => ({ value, label: value }));
    }
    const values: OutputSize[] = modelConfig.maxOutputSize === '4K'
      ? ['1K', '2K', '4K']
      : modelConfig.maxOutputSize === '2K'
        ? ['1K', '2K']
        : modelConfig.maxOutputSize === '512'
          ? ['512']
          : ['1K'];
    return values.map((value) => ({ value, label: value === '512' ? '0.5K' : value }));
  }

  const presetId = getBuiltinPresetId(model);
  if (isSeedreamPreset(presetId)) {
    return [
      { value: '2K', label: '2K' },
      { value: '4K', label: '4K' },
    ];
  }
  if (presetId === 'grok-imagine-image') {
    return [{ value: '1K', label: '1K' }];
  }
  if (presetId === 'grok-imagine-image-quality' || presetId === 'grok-imagine-image-edit') {
    return [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
    ];
  }
  if (presetId === 'gemini-3.1-flash-image-preview') {
    return [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
      { value: '4K', label: '4K' },
    ];
  }
  if (
    presetId === 'gemini-3-pro-image-preview'
    || presetId === 'antigravity-gemini-image'
    || presetId === 'gpt-image-2'
  ) {
    return [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
      { value: '4K', label: '4K' },
    ];
  }
  if (presetId === 'alibaba-qwen-image' || presetId === 'alibaba-wan-image') {
    return [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
    ];
  }
  return [{ value: '1K', label: '1K' }];
}

export function getValidOutputSizes(model: ModelId): OutputSize[] {
  const sizes = getSizeOptions(model).map(option => option.value);
  return supportsAutoLayout(model) ? ['auto', ...sizes] : sizes;
}

export function getOutputSizeLabel(size: OutputSize): string {
  if (size === 'auto') return '自动';
  return size === '512' ? '0.5K' : size;
}

export function getAspectRatioOptions(model: ModelId, outputSize: OutputSize): AspectRatioOption[] {
  const presetId = getBuiltinPresetId(model);
  if (isSeedreamPreset(presetId)) {
    const requestedSize = normalizeSeedreamOutputSize(outputSize);
    const legalSize = getValidOutputSizes(model).includes(requestedSize) ? requestedSize : '2K';
    return BANANA2_ASPECT_RATIOS.map(ar => ({
      value: ar.value,
      label: ar.label,
      resolution: getSeedreamResolution(legalSize, ar.value),
    }));
  }

  if (outputSize === 'auto') {
    if (!supportsAutoLayout(model)) {
      return getAspectRatioOptions(model, '1K');
    }
    return [{ value: 'auto', label: '自动', resolution: '自动' }];
  }

  if (presetId === 'gemini-2.5-flash-image') {
    return BANANA_ASPECT_RATIOS;
  }
  if (presetId === 'gemini-3-pro-image-preview' || presetId === 'antigravity-gemini-image') {
    return BANANA_PRO_ASPECT_RATIOS.map(ar => ({
      value: ar.value,
      label: ar.label,
      resolution: ar.resolutions[outputSize] || ar.resolutions['1K'],
    }));
  }
  if (presetId === 'gpt-image-2') {
    return GPT_IMAGE_ASPECT_RATIOS.map(ar => ({
      value: ar.value,
      label: ar.label,
      resolution: getGptImageResolution(outputSize, ar.value) || '',
    })).filter(option => isGptImage2ProResolutionSupported(option.resolution));
  }
  if (String(presetId).startsWith('gpt-image-2')) {
    return BANANA_ASPECT_RATIOS.map(ar => ({ ...ar, resolution: '' }));
  }
  if (isGrokImagePreset(presetId)) {
    return GROK_IMAGE_ASPECT_RATIOS.map(ar => ({
      value: ar.value,
      label: ar.label,
      resolution: outputSize === '2K' ? '2K' : '1K',
    }));
  }
  if (presetId === 'gemini-3.1-flash-image-preview' || presetId === 'gemini-3.1-flash-lite-image') {
    return BANANA2_ASPECT_RATIOS.map(ar => ({
      value: ar.value,
      label: ar.label,
      resolution: ar.resolutions[outputSize] || ar.resolutions['1K'],
    }));
  }

  return BANANA_ASPECT_RATIOS;
}

export function detectClosestAspectRatio(width: number, height: number, options: AspectRatioOption[]): AspectRatio {
  if (width <= 0 || height <= 0 || options.length === 0) {
    return '1:1';
  }

  const targetRatio = width / height;
  let closestRatio: AspectRatio = options[0]?.value || '1:1';
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const option of options) {
    if (option.value === 'auto') continue;

    const [ratioWidth, ratioHeight] = option.value.split(':').map(Number);
    if (!ratioWidth || !ratioHeight) continue;

    const candidateRatio = ratioWidth / ratioHeight;
    const distance = Math.abs(candidateRatio - targetRatio);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestRatio = option.value;
    }
  }

  return closestRatio;
}

export function getModelDisplayName(model: string): string {
  return getModelOptions().find(option => option.value === model)?.label || getModelConfig(model)?.name || model;
}

export function normalizeModel(candidate?: string): ModelId {
  const fallback = getDefaultModelId();
  if (!candidate) return fallback;
  return getModelOptions().some(option => option.value === candidate)
    ? candidate as ModelId
    : fallback;
}

export function getDefaultRetryLayout(model: ModelId): { outputSize: OutputSize; aspectRatio: AspectRatio } {
  const presetId = getBuiltinPresetId(model);
  if (isSeedreamPreset(presetId)) {
    return { outputSize: '2K', aspectRatio: '1:1' };
  }
  return supportsAutoLayout(model)
    ? { outputSize: 'auto', aspectRatio: 'auto' }
    : { outputSize: '1K', aspectRatio: '1:1' };
}

/** Strip residual auto layout for models that do not support it (Gemini / Antigravity Gemini, etc.). */
const PROMPT_ASPECT_RATIOS = new Set<Exclude<AspectRatio, 'auto'>>([
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
]);

/** Infer a concrete ratio from prompt text (e.g. "淘宝主图3:4" → 3:4). */
export function inferAspectRatioFromPrompt(prompt?: string): Exclude<AspectRatio, 'auto'> | undefined {
  const text = String(prompt || '');
  const match = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (match) {
    const ratio = `${Number(match[1])}:${Number(match[2])}` as Exclude<AspectRatio, 'auto'>;
    if (PROMPT_ASPECT_RATIOS.has(ratio)) return ratio;
  }
  if (/淘宝主图|天猫主图/.test(text)) return '3:4';
  return undefined;
}

/** Prompt-stated ratio wins; then sanitize auto/invalid values for the model. */
export function resolveSubmitLayout(
  model: ModelId,
  outputSize: OutputSize,
  aspectRatio: AspectRatio,
  prompt?: string,
): { outputSize: OutputSize; aspectRatio: AspectRatio } {
  const inferred = inferAspectRatioFromPrompt(prompt);
  if (inferred) {
    const concreteSizes = getValidOutputSizes(model).filter((size): size is Exclude<OutputSize, 'auto'> => size !== 'auto');
    const nextSize = outputSize === 'auto' || !getValidOutputSizes(model).includes(outputSize)
      ? (concreteSizes.includes('1K') ? '1K' : (concreteSizes[0] || '1K'))
      : outputSize;
    return sanitizeLayoutForModel(model, nextSize, inferred);
  }
  return sanitizeLayoutForModel(model, outputSize, aspectRatio);
}

export function sanitizeLayoutForModel(
  model: ModelId,
  outputSize: OutputSize,
  aspectRatio: AspectRatio,
): { outputSize: OutputSize; aspectRatio: AspectRatio } {
  const defaults = getDefaultRetryLayout(model);
  const validSizes = getValidOutputSizes(model);
  let nextSize: OutputSize = validSizes.includes(outputSize) ? outputSize : defaults.outputSize;

  if (!supportsAutoLayout(model) && nextSize === 'auto') {
    nextSize = defaults.outputSize;
  }

  if (nextSize === 'auto') {
    return { outputSize: 'auto', aspectRatio: 'auto' };
  }

  // 用户显式选择的比例在档位不支持时，降档保比例（如 gpt-image-2 4K 档无 1:1，
  // 用户选 1:1 时应降到 2K/1K，而不是偷偷改成 16:9）。
  const sizeRank = { '4K': 3, '2K': 2, '1K': 1, '512': 0 } as Record<string, number>;
  let ratioOptions = getAspectRatioOptions(model, nextSize)
    .map(option => option.value)
    .filter((value): value is Exclude<AspectRatio, 'auto'> => value !== 'auto');
  const hasExplicitRatio = aspectRatio !== defaults.aspectRatio && aspectRatio !== 'auto';
  if (hasExplicitRatio && !ratioOptions.includes(aspectRatio)) {
    const currentRank = sizeRank[nextSize] ?? -1;
    const fallback = validSizes
      .filter((size): size is Exclude<OutputSize, 'auto'> => size !== 'auto')
      .map(size => ({ size, rank: sizeRank[size] ?? -1 }))
      .filter(entry => entry.rank < currentRank)
      .sort((a, b) => b.rank - a.rank)
      .find(entry => (
        getAspectRatioOptions(model, entry.size).map(option => option.value).includes(aspectRatio)
      ));
    if (fallback) {
      nextSize = fallback.size;
      ratioOptions = getAspectRatioOptions(model, nextSize)
        .map(option => option.value)
        .filter((value): value is Exclude<AspectRatio, 'auto'> => value !== 'auto');
    }
  }
  const nextRatio: AspectRatio = ratioOptions.some(value => value === aspectRatio)
    ? aspectRatio
    : (ratioOptions.some(value => value === defaults.aspectRatio) ? defaults.aspectRatio : (ratioOptions[0] || '1:1'));

  return { outputSize: nextSize, aspectRatio: nextRatio };
}

export function isRetryLayoutCompatible(model: ModelId, outputSize: OutputSize, aspectRatio: AspectRatio): boolean {
  const presetId = getBuiltinPresetId(model);
  if (outputSize === 'auto' || aspectRatio === 'auto') {
    return supportsAutoLayout(model) && outputSize === 'auto' && aspectRatio === 'auto';
  }

  if (presetId === 'gemini-2.5-flash-image') {
    return outputSize === '1K';
  }

  if (presetId === 'gemini-3-pro-image-preview' || presetId === 'antigravity-gemini-image') {
    return ['1K', '2K', '4K'].includes(outputSize);
  }

  if (presetId === 'gpt-image-2') {
    const resolution = getGptImageResolution(outputSize, aspectRatio);
    return ['1K', '2K', '4K'].includes(outputSize) && isGptImage2ProResolutionSupported(resolution);
  }

  if (presetId === 'gemini-3.1-flash-image-preview') {
    return ['1K', '2K', '4K'].includes(outputSize);
  }

  if (presetId === 'alibaba-qwen-image' || presetId === 'alibaba-wan-image') {
    return getValidOutputSizes(model).includes(outputSize);
  }

  if (isSeedreamPreset(presetId)) {
    // 必须跟 getSizeOptions 一样尊重注册表上限：maxOutputSize=2K 的配置不应把 4K 视为合法重试档位。
    // 没有注册表条目时（如直接用 preset id 查询），默认放开到 2K/4K。
    const modelConfig = getModelConfig(model);
    const legalSizes = !modelConfig || modelConfig.maxOutputSize === '4K' ? ['2K', '4K'] : ['2K'];
    return legalSizes.includes(outputSize);
  }

  if (presetId === 'gemini-3.1-flash-lite-image') {
    return outputSize === '1K';
  }

  if (presetId === 'grok-imagine-image') {
    return outputSize === '1K';
  }

  if (presetId === 'grok-imagine-image-quality' || presetId === 'grok-imagine-image-edit') {
    return outputSize === '1K' || outputSize === '2K';
  }

  return outputSize === '1K';
}

export function getModelMaxRefImages(model: ModelId): number {
  const modelLimits = getModelImageLimits();
  if (typeof modelLimits[model]?.max === 'number') return Math.max(0, modelLimits[model].max);
  const configured = getModelConfig(model)?.maxRefImages;
  if (typeof configured === 'number' && configured >= 0) return configured;
  return 1;
}

export function supportsReferenceImages(model: ModelId): boolean {
  return getModelMaxRefImages(model) > 0;
}

/** Prefer current model if it accepts refs; otherwise default i2i model or first capable model. */
export function findReferenceCapableModel(preferredId?: string): ModelId | null {
  const registry = loadRegistry();
  const complete = registry.imageModels.filter((model) =>
    Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim()),
  );
  const capable = complete.filter((model) => model.maxRefImages > 0);
  if (capable.length === 0) return null;

  if (preferredId) {
    const preferred = capable.find((model) => model.id === preferredId);
    if (preferred) return preferred.id;
  }

  const defaultI2i = registry.defaults.imageToImage;
  if (defaultI2i) {
    const fromDefault = capable.find((model) => model.id === defaultI2i);
    if (fromDefault) return fromDefault.id;
  }

  const grokEdit = capable.find((model) => model.builtinPreset === 'grok-imagine-image-edit');
  if (grokEdit) return grokEdit.id;

  return capable[0].id;
}

export function getCompatibleRetryData(job: StoredJob): RetryData {
  const model = normalizeModel(job.model);
  const modelCompatible = model === job.model;
  const supportsTemperature = getSupportsTemperature(model);
  const maxRefs = getModelMaxRefImages(model);
  const defaultLayout = getDefaultRetryLayout(model);
  const shouldKeepLayout = modelCompatible && isRetryLayoutCompatible(model, job.output_size, job.aspect_ratio);
  const outputSize: OutputSize = shouldKeepLayout ? job.output_size : defaultLayout.outputSize;
  const aspectRatio: AspectRatio = shouldKeepLayout ? job.aspect_ratio : defaultLayout.aspectRatio;
  const customSize = shouldKeepLayout && supportsCustomSize(model)
    ? normalizeCustomImageSize(job.custom_size, getCustomSizeMaxSide(model))
    : undefined;
  const temperature = supportsTemperature && typeof job.temperature === 'number' ? job.temperature : 1;
  const parallelCount: ParallelCount = PARALLEL_COUNT_VALUES.includes(job.parallelCount as ParallelCount)
    ? (job.parallelCount as ParallelCount)
    : 1;
  const advancedParams = getGptImageAdvancedParamsForModel(model, {
    quality: job.gptImageQuality,
    style: job.gptImageStyle,
    background: job.gptImageBackground,
  });

  return {
    mode: job.mode,
    prompt: job.originalPrompt || job.prompt,
    model,
    outputSize,
    aspectRatio,
    customSize,
    temperature,
    parallelCount,
    gptImageQuality: advancedParams.quality,
    gptImageStyle: advancedParams.style,
    gptImageBackground: advancedParams.background,
    refImages: job.refImages?.slice(0, maxRefs),
  };
}

export function getSupportsTemperature(model: ModelId): boolean {
  if (isGptImageModel(model)) return false;
  const presetId = getBuiltinPresetId(model);
  if (isGrokImagePreset(presetId)) return false;
  if (isSeedreamPreset(presetId)) return false;
  if (presetId === 'alibaba-qwen-image' || presetId === 'alibaba-wan-image') return false;
  if (presetId === 'antigravity-gemini-image') return false;
  const modelConfig = getModelConfig(model);
  if (modelConfig?.protocol === 'grok') return false;
  if (modelConfig?.protocol === 'doubao') return false;
  if (modelConfig?.protocol === 'alibaba-dashscope') return false;
  if (isAntigravityGeminiModel(model, modelConfig)) return false;
  return true;
}

// ===== Agent 提案参数合法化 =====

/** Agent 可用的图像模型目录项，注入到系统指令中供模型选择 */
export interface AgentModelCatalogEntry {
  /** 模型注册 ID（用于 requested_model_id） */
  id: string;
  /** 用户可见的模型名称/别名 */
  name: string;
  /** 最大输出分辨率: '512' | '1K' | '2K' | '4K' */
  maxOutputSize: string;
}

export interface AgentLayoutIntent {
  /** 用户语言明确指定的比例（优先级 1），如 "16:9" */
  requestedAspectRatio?: string;
  /** Agent 智能推荐的比例（优先级 3），如 "2:3" */
  suggestedAspectRatio?: string;
  /** 用户明确要求的清晰度档位，如 "4K"/"2K"/"1K"/"512"/"auto" */
  requestedOutputSize?: string;
  /** 建议温度 0-2 */
  temperature?: number;
  /** 建议并行数量 1-8 */
  parallelCount?: number;
}

export interface AgentResolvedLayout {
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  parallelCount: ParallelCount;
}

function parseRatioString(value?: string): { width: number; height: number } | undefined {
  const match = String(value || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:：xX×/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ===== Agent 模型自动选择 =====

const OUTPUT_SIZE_RANK: Record<string, number> = { '512': 0, '1K': 1, '2K': 2, '4K': 3 };

function canModelSupportSize(maxOutputSize: string, requestedSize: string): boolean {
  return (OUTPUT_SIZE_RANK[maxOutputSize] ?? 0) >= (OUTPUT_SIZE_RANK[requestedSize] ?? 0);
}

/**
 * 按优先级解析 Agent 提案中的模型意图，自动选择最合适的图像模型：
 * 1. Agent 明确指定了模型 id 且该 id 存在 → 直接使用
 * 2. 用户要求了分辨率档位但当前模型不支持 → 自动选择支持该档位且「够用就好」的模型
 * 3. 以上都不满足 → 保持当前模型
 */
export function resolveAgentModel(
  currentModel: ModelId,
  requestedModelId: string | undefined,
  requestedOutputSize: string | undefined,
  availableModels: AgentModelCatalogEntry[],
): ModelId {
  // 1) Agent 明确指定了模型 → 验证后使用
  if (requestedModelId) {
    const found = availableModels.find(m => m.id === requestedModelId);
    if (found) return found.id;
  }

  // 2) 用户要求了分辨率档位，当前模型不支持 → 自动选择支持的模型
  if (requestedOutputSize && requestedOutputSize !== 'auto' && availableModels.length > 0) {
    const current = availableModels.find(m => m.id === currentModel);
    const currentCanSupport = current
      ? canModelSupportSize(current.maxOutputSize, requestedOutputSize)
      : true;
    if (!currentCanSupport) {
      const candidates = availableModels.filter(m =>
        canModelSupportSize(m.maxOutputSize, requestedOutputSize),
      );
      if (candidates.length > 0) {
        // 优先选择最大分辨率刚好满足需求的模型（避免不必要的 4K 模型）
        candidates.sort(
          (a, b) => (OUTPUT_SIZE_RANK[a.maxOutputSize] ?? 0) - (OUTPUT_SIZE_RANK[b.maxOutputSize] ?? 0),
        );
        return candidates[0].id;
      }
    }
  }

  // 3) 无需切换
  return currentModel;
}

/**
 * 按「用户语言 > 上传图分辨率 > Agent 智能选择」的优先级，把 Agent 的参数意图
 * 合法化成当前所选模型实际支持的布局。不合法的比例/档位会贴合到最近的合法值。
 */
export function resolveAgentLayout(
  model: ModelId,
  intent: AgentLayoutIntent,
  refDims?: { width?: number; height?: number },
): AgentResolvedLayout {
  const defaults = getDefaultRetryLayout(model);
  const validSizes = getValidOutputSizes(model);

  // 1) 清晰度档位：仅当用户明确要求且该模型支持时采用，否则用默认
  let outputSize: OutputSize = defaults.outputSize;
  const requestedSize = intent.requestedOutputSize as OutputSize | undefined;
  if (requestedSize && validSizes.includes(requestedSize)) {
    outputSize = requestedSize;
  }

  const explicitRatio = parseRatioString(intent.requestedAspectRatio);

  // 默认 auto 时：若用户用语言明确指定了比例（优先级 1），auto 会吞掉该比例，
  // 故切换到最小的具体档位让比例生效；其余情况保持模型默认 auto。
  if (outputSize === 'auto' && explicitRatio && !requestedSize) {
    const concreteSizes = validSizes.filter(size => size !== 'auto');
    if (concreteSizes.length > 0) {
      outputSize = concreteSizes.includes('1K') ? '1K' : concreteSizes[0];
    }
  }

  // auto 档无需比例，直接返回
  if (outputSize === 'auto') {
    return {
      outputSize,
      aspectRatio: 'auto',
      temperature: getSupportsTemperature(model) ? clampNumber(intent.temperature ?? 1, 0, 2) : 1,
      gptImageQuality: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality,
      gptImageStyle: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style,
      gptImageBackground: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background,
      parallelCount: normalizeParallelCount(intent.parallelCount),
    };
  }

  let ratioOptions = getAspectRatioOptions(model, outputSize).filter(option => option.value !== 'auto');

  // 2) 纵横比优先级：用户语言 > 上传图分辨率 > Agent 智能 > 模型默认
  let aspectRatio: AspectRatio = defaults.aspectRatio === 'auto'
    ? (ratioOptions[0]?.value || '1:1')
    : defaults.aspectRatio;

  const requestedRatio = explicitRatio;
  const refRatio = refDims && refDims.width && refDims.height
    ? { width: refDims.width, height: refDims.height }
    : undefined;
  const suggestedRatio = parseRatioString(intent.suggestedAspectRatio);

  // 用户明确指定了比例（优先级 1）时，比例是第一优先级：当前档位不支持就降档。
  // 例如 gpt-image-2 的 4K 档只支持 16:9/9:16/21:9，用户要 1:1 时应降到 2K/1K
  // 保住 1:1，而不是静默贴成 9:16。档位按 4K > 2K > 1K > 512 顺序找回。
  if (requestedRatio) {
    const requestedRatioLabel = `${requestedRatio.width}:${requestedRatio.height}` as AspectRatio;
    const supported = ratioOptions.some(option => option.value === requestedRatioLabel);
    if (!supported) {
      const sizeRank = { '4K': 3, '2K': 2, '1K': 1, '512': 0 } as Record<string, number>;
      const currentRank = sizeRank[outputSize] ?? -1;
      const fallback = validSizes
        .filter((size): size is Exclude<OutputSize, 'auto'> => size !== 'auto')
        .map(size => ({ size, rank: sizeRank[size] ?? -1 }))
        .filter(entry => entry.rank < currentRank)
        .sort((a, b) => b.rank - a.rank)
        .find(entry => (
          getAspectRatioOptions(model, entry.size).some(option => option.value === requestedRatioLabel)
        ));
      if (fallback) {
        outputSize = fallback.size;
        ratioOptions = getAspectRatioOptions(model, outputSize).filter(option => option.value !== 'auto');
        aspectRatio = requestedRatioLabel;
      }
    }
  }

  const ratioSource = requestedRatio || refRatio || suggestedRatio;
  if (ratioSource && ratioOptions.length > 0) {
    aspectRatio = detectClosestAspectRatio(ratioSource.width, ratioSource.height, ratioOptions);
  } else if (ratioOptions.length > 0 && !ratioOptions.some(option => option.value === aspectRatio)) {
    aspectRatio = ratioOptions[0].value;
  }

  // 3) 自定义尺寸：仅支持自定义尺寸的模型，且能从有效来源算出合法尺寸时填充
  let customSize: string | undefined;
  if (supportsCustomSize(model)) {
    const maxSide = getCustomSizeMaxSide(model);
    const dimsForCustom = requestedRatio ? undefined : refRatio;
    if (dimsForCustom) {
      customSize = normalizeCustomImageSize(`${Math.round(dimsForCustom.width)}x${Math.round(dimsForCustom.height)}`, maxSide);
    }
  }

  const temperature = getSupportsTemperature(model)
    ? clampNumber(intent.temperature ?? 1, 0, 2)
    : 1;

  return {
    outputSize,
    customSize,
    aspectRatio,
    temperature,
    gptImageQuality: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality,
    gptImageStyle: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style,
    gptImageBackground: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background,
    parallelCount: normalizeParallelCount(intent.parallelCount),
  };
}

function normalizeParallelCount(value?: number): ParallelCount {
  const rounded = Math.round(Number(value) || 1);
  const clamped = clampNumber(rounded, 1, 8);
  return clamped as ParallelCount;
}
