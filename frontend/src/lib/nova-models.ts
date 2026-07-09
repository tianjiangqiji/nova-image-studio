'use client';

import {
  getTextProviderDescription,
  isTextProviderProtocol,
  type TextProviderProtocol,
} from '@/lib/nova-text-protocol';

export type ProviderProtocol = 'google' | 'openai';
export type ImageOutputSize = '512' | '1K' | '2K' | '4K';
export type BuiltinImagePresetId =
  | 'gemini-2.5-flash-image'
  | 'gemini-3-pro-image-preview'
  | 'gemini-3.1-flash-image-preview'
  | 'gemini-3.1-flash-lite-image'
  | 'gpt-image-2';

export interface ImageModelConfig {
  id: string;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  builtinPreset: BuiltinImagePresetId;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
}

export interface TextModelConfig {
  id: string;
  protocol: TextProviderProtocol;
  name: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  note?: string;
}

export interface BuiltinImagePreset {
  id: BuiltinImagePresetId;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  baseUrl: string;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
}

export interface DefaultModels {
  textToImage: string;
  imageToImage: string;
  reversePrompt: string;
  agent: string;
  promptOptimize: string;
  imageDescribe: string;
}

export interface NovaModelRegistry {
  imageModels: ImageModelConfig[];
  textModels: TextModelConfig[];
  defaults: DefaultModels;
}

const REGISTRY_KEY = 'nova-model-registry';

export const BUILTIN_IMAGE_PRESETS: Record<BuiltinImagePresetId, BuiltinImagePreset> = {
  'gemini-2.5-flash-image': {
    id: 'gemini-2.5-flash-image',
    protocol: 'google',
    name: 'Banana',
    modelId: 'gemini-2.5-flash-image',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 3,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
  },
  'gemini-3-pro-image-preview': {
    id: 'gemini-3-pro-image-preview',
    protocol: 'google',
    name: 'Banana Pro',
    modelId: 'gemini-3-pro-image-preview',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 14,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
  },
  'gemini-3.1-flash-image-preview': {
    id: 'gemini-3.1-flash-image-preview',
    protocol: 'google',
    name: 'Banana 2',
    modelId: 'gemini-3.1-flash-image-preview',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 14,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
  },
  'gemini-3.1-flash-lite-image': {
    id: 'gemini-3.1-flash-lite-image',
    protocol: 'google',
    name: 'Banana 2 Lite',
    modelId: 'gemini-3.1-flash-lite-image',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 14,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
  },
  'gpt-image-2': {
    id: 'gpt-image-2',
    protocol: 'openai',
    name: 'GPT Image 2',
    modelId: 'gpt-image-2',
    baseUrl: 'https://api.openai.com',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
  },
};

export const BUILTIN_IMAGE_PRESET_OPTIONS = Object.values(BUILTIN_IMAGE_PRESETS).map((preset) => ({
  value: preset.id,
  label: preset.name,
}));

export const DEFAULT_TEXT_MODEL_TEMPLATES = [
  {
    protocol: 'openai-responses' as const,
    name: 'GPT 5.4 Mini',
    modelId: 'gpt-5.4-mini',
    baseUrl: 'https://api.openai.com',
    note: getTextProviderDescription('openai-responses'),
  },
  {
    protocol: 'google-gemini' as const,
    name: 'Gemini 2.5 Flash',
    modelId: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com',
    note: getTextProviderDescription('google-gemini'),
  },
  {
    protocol: 'anthropic-messages' as const,
    name: 'Claude Sonnet',
    modelId: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com',
    note: getTextProviderDescription('anthropic-messages'),
  },
  {
    protocol: 'openai-chat-completions' as const,
    name: 'OpenAI Compatible Chat',
    modelId: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com',
    note: getTextProviderDescription('openai-chat-completions'),
  },
];

export function getDefaultTextModelTemplate(protocol: TextProviderProtocol) {
  return DEFAULT_TEXT_MODEL_TEMPLATES.find((item) => item.protocol === protocol) || DEFAULT_TEXT_MODEL_TEMPLATES[0];
}

export const DEFAULT_DEFAULTS: DefaultModels = {
  textToImage: '',
  imageToImage: '',
  reversePrompt: '',
  agent: '',
  promptOptimize: '',
  imageDescribe: '',
};

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'google' || value === 'openai';
}

function isBuiltinImagePresetId(value: unknown): value is BuiltinImagePresetId {
  return typeof value === 'string' && value in BUILTIN_IMAGE_PRESETS;
}

function normalizeImageOutputSize(value: unknown, fallback: ImageOutputSize): ImageOutputSize {
  return value === '512' || value === '1K' || value === '2K' || value === '4K'
    ? value
    : fallback;
}

function inferBuiltinPresetId(raw: Partial<ImageModelConfig>): BuiltinImagePresetId {
  const candidate = raw.builtinPreset || raw.id || raw.modelId;
  if (isBuiltinImagePresetId(candidate)) return candidate;
  if (String(raw.protocol || '').trim() === 'google') return 'gemini-3-pro-image-preview';
  return 'gpt-image-2';
}

function normalizeImageModelConfig(raw: Partial<ImageModelConfig>): ImageModelConfig | null {
  const presetId = inferBuiltinPresetId(raw);
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  const id = String(raw.id || '').trim();
  if (!id) return null;

  const protocol = isProviderProtocol(raw.protocol) ? raw.protocol : preset.protocol;
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: String(raw.modelId || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || preset.baseUrl).trim(),
    builtinPreset: presetId,
    maxRefImages: Number.isFinite(raw.maxRefImages) && Number(raw.maxRefImages) > 0
      ? Math.max(1, Math.floor(Number(raw.maxRefImages)))
      : preset.maxRefImages,
    maxOutputSize: normalizeImageOutputSize(raw.maxOutputSize, preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai'
      ? (typeof raw.supportsAdvancedParams === 'boolean' ? raw.supportsAdvancedParams : preset.supportsAdvancedParams)
      : false,
  };
}

function normalizeTextModelConfig(raw: Partial<TextModelConfig>): TextModelConfig | null {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const protocol = isTextProviderProtocol(raw.protocol) ? raw.protocol : 'openai-responses';
  const template = getDefaultTextModelTemplate(protocol);
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: String(raw.modelId || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || template.baseUrl).trim(),
    note: typeof raw.note === 'string' ? raw.note : (template.note || getTextProviderDescription(protocol)),
  };
}

function isCompleteImageModel(model: Partial<ImageModelConfig>): model is ImageModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && model.modelId?.trim()
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

function isCompleteTextModel(model: Partial<TextModelConfig>): model is TextModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && model.modelId?.trim()
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

function ensureImageModels(raw?: unknown): ImageModelConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeImageModelConfig((item || {}) as Partial<ImageModelConfig>))
    .filter((item): item is ImageModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

function ensureTextModels(raw?: unknown): TextModelConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeTextModelConfig((item || {}) as Partial<TextModelConfig>))
    .filter((item): item is TextModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

function ensureDefaults(raw: Partial<DefaultModels> | undefined, imageModels: ImageModelConfig[], textModels: TextModelConfig[]): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const firstImageModelId = completeImageModels[0]?.id || '';
  const firstTextModelId = completeTextModels[0]?.id || '';
  const next = { ...DEFAULT_DEFAULTS, ...raw };

  if (!completeImageModels.some((model) => model.id === next.textToImage)) next.textToImage = firstImageModelId;
  if (!completeImageModels.some((model) => model.id === next.imageToImage)) next.imageToImage = firstImageModelId;
  if (!completeTextModels.some((model) => model.id === next.reversePrompt)) next.reversePrompt = firstTextModelId;
  if (!completeTextModels.some((model) => model.id === next.agent)) next.agent = firstTextModelId;
  if (!completeTextModels.some((model) => model.id === next.promptOptimize)) next.promptOptimize = firstTextModelId;
  if (!completeTextModels.some((model) => model.id === next.imageDescribe)) next.imageDescribe = firstTextModelId;

  return next;
}

function getInitialRegistry(): NovaModelRegistry {
  return {
    imageModels: [],
    textModels: [],
    defaults: DEFAULT_DEFAULTS,
  };
}

export function loadRegistry(): NovaModelRegistry {
  if (typeof window === 'undefined') {
    return getInitialRegistry();
  }

  const raw = localStorage.getItem(REGISTRY_KEY);
  if (!raw) {
    return getInitialRegistry();
  }

  const parsed = JSON.parse(raw) as Partial<NovaModelRegistry>;
  const imageModels = ensureImageModels(parsed.imageModels);
  const textModels = ensureTextModels(parsed.textModels);
  const defaults = ensureDefaults(parsed.defaults, imageModels, textModels);
  return { imageModels, textModels, defaults };
}

export function saveRegistry(registry: NovaModelRegistry): void {
  if (typeof window === 'undefined') return;

  const imageModels = ensureImageModels(registry.imageModels);
  const textModels = ensureTextModels(registry.textModels);
  const normalized: NovaModelRegistry = {
    imageModels,
    textModels,
    defaults: ensureDefaults(registry.defaults, imageModels, textModels),
  };

  localStorage.setItem(REGISTRY_KEY, JSON.stringify(normalized));
}

export function getImageModelById(registry: NovaModelRegistry, id: string): ImageModelConfig | undefined {
  return registry.imageModels.find((model) => model.id === id);
}

export function getTextModelById(registry: NovaModelRegistry, id: string): TextModelConfig | undefined {
  return registry.textModels.find((model) => model.id === id);
}

export function getDefaultImageModel(
  registry: NovaModelRegistry,
  task: keyof Pick<DefaultModels, 'textToImage' | 'imageToImage'>,
): ImageModelConfig | undefined {
  return getImageModelById(registry, registry.defaults[task]);
}

export function getDefaultTextModel(
  registry: NovaModelRegistry,
  task: keyof Pick<DefaultModels, 'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe'>,
): TextModelConfig | undefined {
  return getTextModelById(registry, registry.defaults[task]);
}

export function getCompleteImageModels(registry: NovaModelRegistry): ImageModelConfig[] {
  return registry.imageModels.filter(isCompleteImageModel);
}

export function getCompleteTextModels(registry: NovaModelRegistry): TextModelConfig[] {
  return registry.textModels.filter(isCompleteTextModel);
}

export function getImageModelOutputSizes(model: ImageModelConfig): ImageOutputSize[] {
  switch (model.maxOutputSize) {
    case '4K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K', '4K']
        : ['1K', '2K', '4K'];
    case '2K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K']
        : ['1K', '2K'];
    case '512':
      return ['512'];
    case '1K':
    default:
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K']
        : ['1K'];
  }
}

export function generateModelId(prefix: string = 'model'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
