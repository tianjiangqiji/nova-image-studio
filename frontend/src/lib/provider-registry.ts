import type {
  BuiltinImagePresetId,
  ImageModelConfig,
  ImageOutputSize,
  ProviderProtocol,
  TextModelConfig,
} from '@/lib/nova-models';
import { getTextProviderLabel, isTextProviderProtocol, type TextProviderProtocol } from '@/lib/nova-text-protocol';

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export type ModelUse = 'text' | 'image' | 'video' | 'audio';

export type ProviderKind =
  | 'openai-compatible'
  | 'google'
  | 'anthropic-messages'
  | 'grok'
  | 'doubao'
  | 'alibaba-dashscope';

export interface ProviderModelEntry {
  id?: string;
  modelId: string;
  name: string;
  uses: ModelUse[];
  manual?: boolean;
  imageConfigId?: string;
  textConfigId?: string;
  builtinPreset?: BuiltinImagePresetId;
  textProtocol?: TextProviderProtocol;
  maxRefImages?: number;
  maxOutputSize?: ImageOutputSize;
  supportsAdvancedParams?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  apiKey: string;
  baseUrl: string;
  models: ProviderModelEntry[];
}

export const PROVIDER_KIND_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'anthropic-messages', label: 'Claude Messages' },
  { value: 'grok', label: 'Grok / xAI' },
  { value: 'doubao', label: '豆包 Seedream' },
  { value: 'alibaba-dashscope', label: '阿里百炼' },
];

export const MODEL_USE_OPTIONS: { value: ModelUse; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

const MODEL_USES: ModelUse[] = ['text', 'image', 'video', 'audio'];

function trimTrailingSlashes(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function normalizeProviderBaseUrl(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl);
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return PROVIDER_KIND_OPTIONS.some((option) => option.value === value);
}

function isModelUse(value: unknown): value is ModelUse {
  return value === 'text' || value === 'image' || value === 'video' || value === 'audio';
}

export function listProtocolForKind(kind: ProviderKind): string {
  if (kind === 'google') return 'google';
  if (kind === 'anthropic-messages') return 'anthropic-messages';
  return 'openai';
}

export function imageProtocolForKind(kind: ProviderKind): ProviderProtocol {
  if (kind === 'google') return 'google';
  if (kind === 'grok') return 'grok';
  if (kind === 'doubao') return 'doubao';
  if (kind === 'alibaba-dashscope') return 'alibaba-dashscope';
  return 'openai';
}

export function textProtocolForKind(kind: ProviderKind): TextProviderProtocol {
  if (kind === 'google') return 'google-gemini';
  if (kind === 'anthropic-messages') return 'anthropic-messages';
  return 'openai-chat-completions';
}

export function guessTextProtocol(kind: ProviderKind, modelId: string): TextProviderProtocol {
  if (kind === 'google') return 'google-gemini';
  if (kind === 'anthropic-messages') return 'anthropic-messages';
  const id = String(modelId || '').toLowerCase();
  if (/^gpt-5(\b|[.-])|^o[1-4](\b|[.-])|^chatgpt/.test(id)) return 'openai-responses';
  return textProtocolForKind(kind);
}

export const TEXT_PROTOCOL_OPTIONS: { value: TextProviderProtocol; label: string }[] = [
  { value: 'openai-responses', label: getTextProviderLabel('openai-responses') },
  { value: 'openai-chat-completions', label: getTextProviderLabel('openai-chat-completions') },
  { value: 'anthropic-messages', label: getTextProviderLabel('anthropic-messages') },
  { value: 'google-gemini', label: getTextProviderLabel('google-gemini') },
];

export function inferImagePreset(kind: ProviderKind, modelId: string): BuiltinImagePresetId {
  const id = String(modelId || '').toLowerCase();
  if (kind === 'google' || (id.includes('gemini') && id.includes('image'))) {
    if (kind === 'openai-compatible' || kind === 'grok' || kind === 'doubao' || kind === 'alibaba-dashscope') {
      return 'antigravity-gemini-image';
    }
    if (id.includes('lite')) return 'gemini-3.1-flash-lite-image';
    if (id.includes('3.1') && id.includes('flash')) return 'gemini-3.1-flash-image-preview';
    if (id.includes('pro')) return 'gemini-3-pro-image-preview';
    if (id.includes('2.5')) return 'gemini-2.5-flash-image';
    return kind === 'google' ? 'gemini-3-pro-image-preview' : 'antigravity-gemini-image';
  }
  if (kind === 'grok' || id.includes('grok-imagine')) {
    if (id.includes('edit')) return 'grok-imagine-image-edit';
    if (id.includes('quality')) return 'grok-imagine-image-quality';
    return 'grok-imagine-image';
  }
  if (kind === 'doubao' || id.includes('seedream') || id.includes('doubao')) {
    return 'doubao-seedream';
  }
  if (kind === 'alibaba-dashscope' || id.includes('qwen-image') || id.includes('wan2')) {
    if (id.includes('wan2')) return 'alibaba-wan-image';
    return 'alibaba-qwen-image';
  }
  return 'gpt-image-2';
}

export function guessModelUses(modelId: string): ModelUse[] {
  const id = String(modelId || '').toLowerCase();
  const uses: ModelUse[] = [];
  const isVideo = /sora|kling|runway|luma|\bveo\b|imagine-video|[-_/]video/.test(id);
  const isAudio = /\btts\b|whisper|speech|\baudio\b/.test(id);
  // 只认明确的生图 id。裸 grok-imagine 不是图模，避免自动读取后误勾「图片」。
  const isImage = /imagen|dall-e|dalle|gpt-image|seedream|banana|flux|wan2|qwen-image|grok-imagine-image|grok-imagine-edit/.test(id)
    || (/(^|[^a-z])image([^a-z]|$)/.test(id) && !isVideo);
  if (isVideo) uses.push('video');
  if (isAudio) uses.push('audio');
  if (isImage) uses.push('image');
  if (uses.length === 0) uses.push('text');
  return uses;
}

export function providerModelRowId(entry: Pick<ProviderModelEntry, 'id' | 'modelId' | 'imageConfigId' | 'textConfigId'>): string {
  return String(entry.id || entry.imageConfigId || entry.textConfigId || `row_${entry.modelId}`).trim();
}

export function parseUpstreamModelList(payload: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const id = String(raw || '').trim().replace(/^models\//, '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  if (!payload || typeof payload !== 'object') return ids;
  const data = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (typeof item === 'string') {
        add(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const row = item as { id?: unknown; model?: unknown; name?: unknown };
      add(String(row.id || row.model || row.name || ''));
    }
  }
  if (Array.isArray(data.models)) {
    for (const item of data.models) {
      if (typeof item === 'string') {
        add(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      add(String((item as { name?: unknown }).name || ''));
    }
  }
  return ids;
}

export function mergeFetchedModels(
  existing: ProviderModelEntry[],
  fetchedIds: string[],
): ProviderModelEntry[] {
  const byId = new Map(existing.map((entry) => [entry.modelId, entry]));
  const next = [...existing];
  for (const modelId of fetchedIds) {
    if (byId.has(modelId)) continue;
    const entry: ProviderModelEntry = {
      id: createId('row'),
      modelId,
      name: modelId,
      uses: guessModelUses(modelId),
    };
    byId.set(modelId, entry);
    next.push(entry);
  }
  return next;
}

function normalizeUses(raw: unknown): ModelUse[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isModelUse).filter((use, index, list) => list.indexOf(use) === index);
}

export function normalizeProviderModelEntry(raw: Partial<ProviderModelEntry> | null | undefined): ProviderModelEntry | null {
  const modelId = String(raw?.modelId || '').trim();
  if (!modelId) return null;
  return {
    id: providerModelRowId({
      id: String(raw?.id || '').trim(),
      modelId,
      imageConfigId: String(raw?.imageConfigId || '').trim() || undefined,
      textConfigId: String(raw?.textConfigId || '').trim() || undefined,
    }),
    modelId,
    name: String(raw?.name || modelId).trim() || modelId,
    uses: normalizeUses(raw?.uses),
    manual: raw?.manual === true,
    imageConfigId: String(raw?.imageConfigId || '').trim() || undefined,
    textConfigId: String(raw?.textConfigId || '').trim() || undefined,
    builtinPreset: raw?.builtinPreset,
    textProtocol: isTextProviderProtocol(raw?.textProtocol) ? raw.textProtocol : undefined,
    maxRefImages: raw?.maxRefImages,
    maxOutputSize: raw?.maxOutputSize,
    supportsAdvancedParams: raw?.supportsAdvancedParams,
  };
}

export function normalizeProviderConfig(raw: Partial<ProviderConfig> | null | undefined): ProviderConfig | null {
  const id = String(raw?.id || '').trim();
  if (!id) return null;
  const models = Array.isArray(raw?.models)
    ? raw.models
      .map((item) => normalizeProviderModelEntry(item))
      .filter((item): item is ProviderModelEntry => Boolean(item))
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
    : [];
  return {
    id,
    name: String(raw?.name || '').trim(),
    kind: isProviderKind(raw?.kind) ? raw.kind : 'openai-compatible',
    apiKey: String(raw?.apiKey || '').trim(),
    baseUrl: normalizeProviderBaseUrl(String(raw?.baseUrl || '')),
    models,
  };
}

export function ensureProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeProviderConfig((item || {}) as Partial<ProviderConfig>))
    .filter((item): item is ProviderConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

export function createProviderDraft(): ProviderConfig {
  return {
    id: createId('prov'),
    name: '',
    kind: 'openai-compatible',
    apiKey: '',
    baseUrl: '',
    models: [],
  };
}

export function addManualProviderModel(provider: ProviderConfig, modelId: string): ProviderConfig {
  const id = String(modelId || '').trim();
  if (!id) return provider;
  const duplicateCount = provider.models.filter((entry) => entry.modelId === id).length;
  return {
    ...provider,
    models: [
      ...provider.models,
      {
        id: createId('row'),
        modelId: id,
        name: duplicateCount > 0 ? `${id} (${duplicateCount + 1})` : id,
        uses: guessModelUses(id),
        manual: true,
      },
    ],
  };
}

export function toggleProviderModelUse(
  provider: ProviderConfig,
  rowId: string,
  use: ModelUse,
): ProviderConfig {
  const matchedByRowId = provider.models.filter((entry) => providerModelRowId(entry) === rowId);
  const targets = matchedByRowId.length > 0
    ? matchedByRowId
    : provider.models.filter((entry) => entry.modelId === rowId);
  const targetKeys = new Set(targets.map((entry) => providerModelRowId(entry)));
  return {
    ...provider,
    models: provider.models.map((entry) => {
      if (!targetKeys.has(providerModelRowId(entry))) return entry;
      const has = entry.uses.includes(use);
      return {
        ...entry,
        uses: has ? entry.uses.filter((item) => item !== use) : [...entry.uses, use],
      };
    }),
  };
}

function kindFromLegacy(protocol: string): ProviderKind {
  if (protocol === 'google' || protocol === 'google-gemini') return 'google';
  if (protocol === 'anthropic-messages') return 'anthropic-messages';
  if (protocol === 'grok') return 'grok';
  if (protocol === 'doubao') return 'doubao';
  if (protocol === 'alibaba-dashscope') return 'alibaba-dashscope';
  return 'openai-compatible';
}

function groupKey(apiKey: string, baseUrl: string): string {
  return `${apiKey.trim()}@@${normalizeProviderBaseUrl(baseUrl).toLowerCase()}`;
}

export function migrateLegacyProviders(
  imageModels: ImageModelConfig[],
  textModels: TextModelConfig[],
): ProviderConfig[] {
  const groups = new Map<string, ProviderConfig>();

  const takeGroup = (apiKey: string, baseUrl: string, protocol: string, name: string): ProviderConfig => {
    const key = groupKey(apiKey, baseUrl);
    const existing = groups.get(key);
    if (existing) return existing;
    const provider: ProviderConfig = {
      id: createId('prov'),
      name: name.trim() || '供应商',
      kind: kindFromLegacy(protocol),
      apiKey: apiKey.trim(),
      baseUrl: normalizeProviderBaseUrl(baseUrl),
      models: [],
    };
    groups.set(key, provider);
    return provider;
  };

  for (const model of imageModels) {
    const provider = takeGroup(model.apiKey, model.baseUrl, model.protocol, model.name);
    const current = provider.models.find((entry) => entry.modelId === model.modelId);
    if (current) {
      if (!current.uses.includes('image')) current.uses.push('image');
      current.imageConfigId = model.id;
      current.builtinPreset = model.builtinPreset;
      continue;
    }
    provider.models.push({
      id: model.id || createId('row'),
      modelId: model.modelId,
      name: model.name || model.modelId,
      uses: ['image'],
      imageConfigId: model.id,
      builtinPreset: model.builtinPreset,
      maxRefImages: model.maxRefImages,
      maxOutputSize: model.maxOutputSize,
      supportsAdvancedParams: model.supportsAdvancedParams,
    });
  }

  for (const model of textModels) {
    const provider = takeGroup(model.apiKey, model.baseUrl, model.protocol, model.name);
    const current = provider.models.find((entry) => entry.modelId === model.modelId);
    if (current) {
      if (!current.uses.includes('text')) current.uses.push('text');
      current.textConfigId = model.id;
      if (isTextProviderProtocol(model.protocol)) current.textProtocol = model.protocol;
      continue;
    }
    provider.models.push({
      id: model.id || createId('row'),
      modelId: model.modelId,
      name: model.name || model.modelId,
      uses: ['text'],
      textConfigId: model.id,
      textProtocol: isTextProviderProtocol(model.protocol) ? model.protocol : undefined,
    });
  }

  return [...groups.values()];
}

export function isCompleteProvider(provider: ProviderConfig): boolean {
  return Boolean(provider.name.trim() && provider.apiKey.trim() && provider.baseUrl.trim());
}

export { MODEL_USES };
