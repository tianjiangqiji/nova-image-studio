'use client';

import {
  getTextProviderDescription,
  isTextProviderProtocol,
  type TextProviderProtocol,
} from '@/lib/nova-text-protocol';
import {
  ensureProviders,
  guessTextProtocol,
  imageProtocolForKind,
  inferImagePreset,
  migrateLegacyProviders,
  normalizeProviderBaseUrl,
  type ProviderConfig,
} from '@/lib/provider-registry';

export type ProviderProtocol = 'google' | 'openai' | 'grok' | 'doubao' | 'alibaba-dashscope';
export type ImageOutputSize = '512' | '1K' | '2K' | '4K';
export type BuiltinImagePresetId =
  | 'gemini-2.5-flash-image'
  | 'gemini-3-pro-image-preview'
  | 'gemini-3.1-flash-image-preview'
  | 'gemini-3.1-flash-lite-image'
  | 'antigravity-gemini-image'
  | 'gpt-image-2'
  | 'grok-imagine-image'
  | 'grok-imagine-image-quality'
  | 'grok-imagine-image-edit'
  | 'doubao-seedream'
  | 'alibaba-qwen-image'
  | 'alibaba-wan-image';

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
  /** 图片切图的 AI 拆图（视觉定位切片与背景候选） */
  sliceDecomposition: string;
  /** 网页复刻 agent（多轮工具调用生成 HTML/CSS/JS） */
  sliceReconstruct: string;
  /**
   * 切图的图片编辑能力（AI 透明化、背景补齐）。
   * 与 textToImage / imageToImage 分开配置，因为这两项要求上游支持
   * 带 mask 的 /v1/images/edits，只有 openai 协议的模型满足（见 isSliceCapableImageModel）。
   */
  sliceImageEdit: string;
}

/** 文本类默认模型的 task key。 */
export type TextDefaultTask = keyof Pick<
  DefaultModels,
  'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe' | 'sliceDecomposition' | 'sliceReconstruct'
>;

const TEXT_DEFAULT_TASKS: TextDefaultTask[] = [
  'reversePrompt',
  'agent',
  'promptOptimize',
  'imageDescribe',
  'sliceDecomposition',
  'sliceReconstruct',
];

export interface NovaModelRegistry {
  providers?: ProviderConfig[];
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
  'antigravity-gemini-image': {
    id: 'antigravity-gemini-image',
    protocol: 'openai',
    name: 'Antigravity Gemini',
    modelId: 'gemini-3-pro-image-preview',
    baseUrl: '',
    maxRefImages: 14,
    maxOutputSize: '4K',
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
  'grok-imagine-image': {
    id: 'grok-imagine-image',
    protocol: 'grok',
    name: 'Grok Imagine',
    modelId: 'grok-imagine-image',
    baseUrl: 'https://api.x.ai',
    maxRefImages: 0,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
  },
  'grok-imagine-image-quality': {
    id: 'grok-imagine-image-quality',
    protocol: 'grok',
    name: 'Grok Imagine Quality',
    modelId: 'grok-imagine-image-quality',
    baseUrl: 'https://api.x.ai',
    maxRefImages: 0,
    maxOutputSize: '2K',
    supportsAdvancedParams: false,
  },
  'grok-imagine-image-edit': {
    id: 'grok-imagine-image-edit',
    protocol: 'grok',
    name: 'Grok Imagine Edit',
    modelId: 'grok-imagine-image-edit',
    baseUrl: 'https://api.x.ai',
    maxRefImages: 3,
    maxOutputSize: '2K',
    supportsAdvancedParams: false,
  },
  'doubao-seedream': {
    id: 'doubao-seedream',
    protocol: 'doubao',
    name: 'Seedream（豆包）',
    modelId: 'doubao-seedream-5.0-lite',
    baseUrl: 'https://ark.cn-beijing.volces.com/api',
    maxRefImages: 14,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
  },
  'alibaba-qwen-image': {
    id: 'alibaba-qwen-image',
    protocol: 'alibaba-dashscope',
    name: 'Qwen Image 3.0 Pro（阿里）',
    modelId: 'qwen-image-3.0-pro',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com',
    maxRefImages: 3,
    maxOutputSize: '2K',
    supportsAdvancedParams: false,
  },
  'alibaba-wan-image': {
    id: 'alibaba-wan-image',
    protocol: 'alibaba-dashscope',
    name: '万相 Wan2.7 Image（阿里）',
    modelId: 'wan2.7-image',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com',
    maxRefImages: 9,
    maxOutputSize: '2K',
    supportsAdvancedParams: false,
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
  sliceDecomposition: '',
  sliceReconstruct: '',
  sliceImageEdit: '',
};

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'google' || value === 'openai' || value === 'grok' || value === 'doubao' || value === 'alibaba-dashscope';
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
  const protocol = String(raw.protocol || '').trim();
  if (protocol === 'google') return 'gemini-3-pro-image-preview';
  if (protocol === 'grok') return 'grok-imagine-image';
  if (protocol === 'doubao') return 'doubao-seedream';
  if (protocol === 'alibaba-dashscope') return 'alibaba-qwen-image';
  return 'gpt-image-2';
}

function normalizeImageModelConfig(raw: Partial<ImageModelConfig>): ImageModelConfig | null {
  const presetId = inferBuiltinPresetId(raw);
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  const id = String(raw.id || '').trim();
  if (!id) return null;

  const protocol = isProviderProtocol(raw.protocol) ? raw.protocol : preset.protocol;
  const normalizedMaxOutputSize = normalizeImageOutputSize(raw.maxOutputSize, preset.maxOutputSize);
  const maxOutputSize: ImageOutputSize = presetId === 'doubao-seedream' && normalizedMaxOutputSize !== '4K'
    ? '2K'
    : normalizedMaxOutputSize;
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: String(raw.modelId || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || preset.baseUrl).trim(),
    builtinPreset: presetId,
    // 历史 bug 自愈：这三个预设曾写入错误的默认上限（qwen/wan=0、seedream=6），
    // 已存入 localStorage 的记录会被锁死在旧值，这里在加载时还原为预设的官方上限
    maxRefImages: (() => {
      const stored = Number(raw.maxRefImages);
      const buggyDefault =
        (presetId === 'alibaba-qwen-image' || presetId === 'alibaba-wan-image') ? 0
        : presetId === 'doubao-seedream' ? 6
        : null;
      if (buggyDefault !== null && stored === buggyDefault) {
        return preset.maxRefImages;
      }
      return Number.isFinite(raw.maxRefImages) && stored >= 0
        ? Math.max(0, Math.floor(stored))
        : preset.maxRefImages;
    })(),
    maxOutputSize,
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
  for (const task of TEXT_DEFAULT_TASKS) {
    if (!completeTextModels.some((model) => model.id === next[task])) next[task] = firstTextModelId;
  }

  // 切图的图片编辑只能落在支持带 mask 编辑的模型上；没有这类模型时留空，
  // 由 UI 提示用户去添加，而不是硬塞一个注定 400 的模型。
  const sliceCapable = completeImageModels.filter(isSliceCapableImageModel);
  if (!sliceCapable.some((model) => model.id === next.sliceImageEdit)) {
    next.sliceImageEdit = sliceCapable[0]?.id || '';
  }

  return next;
}

/**
 * 该图片模型能否用于切图的图片编辑（AI 透明化 / 背景补齐）。
 *
 * 这两项都要打 `/v1/images/edits`，并且背景补齐还要传 `mask`。
 * 只有真 GPT Image 这类 openai 协议模型有这个端点。
 * Gemini 走 generateContent 没有 mask 语义；Antigravity Gemini 虽然挂 openai
 * 协议，上游仍是 Gemini image，同样没有 mask edits。
 * Grok 的 edits 也不接受 mask 参数。所以在选择器层就把它们过滤掉，
 * 而不是等请求 400 才告诉用户。
 */
export function isSliceCapableImageModel(model: ImageModelConfig): boolean {
  if (model.protocol !== 'openai') return false;
  if (model.builtinPreset === 'antigravity-gemini-image') return false;
  const modelId = String(model.modelId || '').toLowerCase();
  if (modelId.includes('gemini') && modelId.includes('image')) return false;
  return true;
}

/** 可用于切图图片编辑的模型列表。 */
export function getSliceCapableImageModels(registry: NovaModelRegistry): ImageModelConfig[] {
  return getCompleteImageModels(registry).filter(isSliceCapableImageModel);
}

function getInitialRegistry(): NovaModelRegistry {
  return {
    providers: [],
    imageModels: [],
    textModels: [],
    defaults: DEFAULT_DEFAULTS,
  };
}

function isGeminiImageModelId(modelId: string): boolean {
  const id = String(modelId || '').toLowerCase();
  return id.includes('gemini') && id.includes('image');
}

function isGptImageModelId(modelId: string): boolean {
  const id = String(modelId || '').toLowerCase();
  return id.includes('gpt-image') || id.includes('dall-e') || id.includes('dalle');
}

export function resolveDerivedImagePreset(
  kind: ProviderConfig['kind'],
  modelId: string,
  stored?: BuiltinImagePresetId,
): BuiltinImagePresetId {
  const inferred = inferImagePreset(kind, modelId);
  const storedOk = stored && stored in BUILTIN_IMAGE_PRESETS ? stored : undefined;
  if (isGeminiImageModelId(modelId) && (!storedOk || storedOk.startsWith('gpt-image') || storedOk.startsWith('grok-') || storedOk.startsWith('doubao') || storedOk.startsWith('alibaba'))) {
    return inferred;
  }
  if (isGptImageModelId(modelId)) return 'gpt-image-2';
  return storedOk || inferred;
}

export function resolveDerivedImageProtocol(
  kind: ProviderConfig['kind'],
  modelId: string,
  presetId: BuiltinImagePresetId,
): ProviderProtocol {
  if (presetId.startsWith('grok-') || /grok-imagine-image|grok-imagine-edit/.test(modelId.toLowerCase())) return 'grok';
  if (presetId.startsWith('doubao') || modelId.toLowerCase().includes('seedream')) return 'doubao';
  if (presetId.startsWith('alibaba') || /qwen-image|^wan2/.test(modelId.toLowerCase())) return 'alibaba-dashscope';
  if (isGptImageModelId(modelId) || presetId.startsWith('gpt-image')) return 'openai';
  if (presetId === 'antigravity-gemini-image') return 'openai';
  if (presetId.startsWith('gemini') || isGeminiImageModelId(modelId)) {
    return kind === 'google' ? 'google' : 'openai';
  }
  return imageProtocolForKind(kind);
}

function uniquifyDisplayNames<T extends { name: string; modelId: string }>(
  models: T[],
  providerNames: string[],
): T[] {
  const used = new Map<string, number>();
  return models.map((model, index) => {
    const base = model.name.trim() || model.modelId;
    const provider = String(providerNames[index] || '').trim();
    const clash = models.filter((item) => (item.name.trim() || item.modelId) === base).length > 1;
    let name = clash && provider && provider !== base ? `${base}（${provider}）` : base;
    const count = (used.get(name) || 0) + 1;
    used.set(name, count);
    if (count > 1) name = `${name} · ${count}`;
    return { ...model, name };
  });
}

export function deriveImageAndTextModels(providers: ProviderConfig[]): {
  imageModels: ImageModelConfig[];
  textModels: TextModelConfig[];
} {
  const imageModels: ImageModelConfig[] = [];
  const textModels: TextModelConfig[] = [];
  const imageProviderNames: string[] = [];
  const textProviderNames: string[] = [];

  for (const provider of providers) {
    const apiKey = provider.apiKey.trim();
    const baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
    if (!apiKey || !baseUrl) continue;

    for (const entry of provider.models) {
      if (entry.uses.includes('image')) {
        const presetId = resolveDerivedImagePreset(provider.kind, entry.modelId, entry.builtinPreset);
        const preset = BUILTIN_IMAGE_PRESETS[presetId];
        const protocol = resolveDerivedImageProtocol(provider.kind, entry.modelId, presetId);
        imageModels.push({
          id: entry.imageConfigId || `${provider.id}::img::${entry.modelId}`,
          protocol,
          name: String(entry.name || '').trim() || entry.modelId,
          modelId: entry.modelId,
          apiKey,
          baseUrl,
          builtinPreset: presetId,
          maxRefImages: Number.isFinite(entry.maxRefImages) && Number(entry.maxRefImages) >= 0
            ? Math.floor(Number(entry.maxRefImages))
            : preset.maxRefImages,
          maxOutputSize: entry.maxOutputSize || preset.maxOutputSize,
          supportsAdvancedParams: protocol === 'openai'
            ? (typeof entry.supportsAdvancedParams === 'boolean'
              ? entry.supportsAdvancedParams
              : preset.supportsAdvancedParams)
            : false,
        });
        imageProviderNames.push(provider.name);
      }

      if (entry.uses.includes('text')) {
        const protocol = isTextProviderProtocol(entry.textProtocol)
          ? entry.textProtocol
          : guessTextProtocol(provider.kind, entry.modelId);
        textModels.push({
          id: entry.textConfigId || `${provider.id}::txt::${entry.modelId}`,
          protocol,
          name: String(entry.name || '').trim() || entry.modelId,
          modelId: entry.modelId,
          apiKey,
          baseUrl,
          note: getTextProviderDescription(protocol),
        });
        textProviderNames.push(provider.name);
      }
    }
  }

  return {
    imageModels: uniquifyDisplayNames(imageModels, imageProviderNames),
    textModels: uniquifyDisplayNames(textModels, textProviderNames),
  };
}

function hydrateRegistry(parsed: Partial<NovaModelRegistry>): NovaModelRegistry {
  let providers = ensureProviders(parsed.providers);
  const legacyImageModels = ensureImageModels(parsed.imageModels);
  const legacyTextModels = ensureTextModels(parsed.textModels);
  if (providers.length === 0 && (legacyImageModels.length > 0 || legacyTextModels.length > 0)) {
    providers = migrateLegacyProviders(legacyImageModels, legacyTextModels);
  }
  const derived = deriveImageAndTextModels(providers);
  const imageModels = derived.imageModels.length > 0 || providers.length > 0
    ? derived.imageModels
    : legacyImageModels;
  const textModels = derived.textModels.length > 0 || providers.length > 0
    ? derived.textModels
    : legacyTextModels;
  return {
    providers,
    imageModels,
    textModels,
    defaults: ensureDefaults(parsed.defaults, imageModels, textModels),
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

  return hydrateRegistry(JSON.parse(raw) as Partial<NovaModelRegistry>);
}

export function saveRegistry(registry: NovaModelRegistry): void {
  if (typeof window === 'undefined') return;
  const normalized = hydrateRegistry(registry);
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
  task: keyof Pick<DefaultModels, 'textToImage' | 'imageToImage' | 'sliceImageEdit'>,
): ImageModelConfig | undefined {
  return getImageModelById(registry, registry.defaults[task]);
}

export function getDefaultTextModel(
  registry: NovaModelRegistry,
  task: TextDefaultTask,
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
  if (model.builtinPreset === 'doubao-seedream') {
    return model.maxOutputSize === '4K' ? ['2K', '4K'] : ['2K'];
  }

  switch (model.maxOutputSize) {
    case '4K':
      return ['1K', '2K', '4K'];
    case '2K':
      return ['1K', '2K'];
    case '512':
      return ['512'];
    case '1K':
    default:
      return ['1K'];
  }
}

export function generateModelId(prefix: string = 'model'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
