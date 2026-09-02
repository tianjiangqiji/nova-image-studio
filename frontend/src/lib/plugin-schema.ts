/**
 * 插件 ui.schema 的类型与求解。
 *
 * 宿主不认识任何具体上游：facet 之间的组合关系写在 `modelSelector.variants` 这张扁平表里，
 * 「哪些选项可用、哪个素材槽放几个、哪个字段变必填」全部由这里从 schema 求出来。
 *
 * 后端 backend/plugin-runtime/input.js 是同一套规则的权威实现。这一份只用于即时反馈，
 * 提交仍会被后端重新校验一遍——Node 与 TS 之间没法共享实现，宁可写两遍也不能让后端信任前端。
 */

export type MediaKind = 'images' | 'videos' | 'audios';

export type PluginFieldType = 'textarea' | 'text' | 'select' | 'select-grid' | 'media' | 'switch';

/** `{ "mode": ["first-last-frame"] }`：所有键都要命中，键内任一命中即可 */
export type FacetCondition = Record<string, (string | number)[]>;

export interface PluginFacet {
  key: string;
  label: string;
  icon?: string;
  control?: string;
  /** 只有一个可选值时不显示这个控件 */
  hideWhenSingle?: boolean;
}

export interface PluginFacetOption {
  value: string | number;
  label: string;
  /** 展开列表里用的完整名称，缺省用 label */
  fullLabel?: string;
  description?: string;
}

export interface PluginVariant {
  model: string;
  [facetKey: string]: string | number;
}

export interface PluginModelSelector {
  label?: string;
  familyLabel?: string;
  familyDescription?: string;
  facets: PluginFacet[];
  facetOptions: Record<string, PluginFacetOption[]>;
  variants: PluginVariant[];
}

export interface PluginFieldOption {
  value: string | number;
  label: string;
  description?: string;
  /** 只有在这些 facet / 字段取值下才可选 */
  availableWhen?: FacetCondition;
}

export interface PluginMediaMaxCount {
  byFacet: string;
  values: Record<string, number>;
  default?: number;
}

export interface PluginField {
  key: string;
  type: PluginFieldType;
  label?: string;
  icon?: string;
  hint?: string;
  /** 变必填时替换 hint 的文案 */
  requiredHint?: string;
  placeholder?: string;
  required?: boolean;
  requiredIf?: FacetCondition;
  showIf?: FacetCondition;
  hideWhenSingle?: boolean;
  default?: string | number | boolean;
  maxLength?: number;
  rows?: number;
  columns?: number;
  suffix?: string;
  presets?: string[];
  options?: PluginFieldOption[];
  /** type=media */
  kind?: MediaKind;
  style?: 'thumbnail' | 'chip' | 'frame';
  accent?: string;
  maxCount?: number | PluginMediaMaxCount;
}

export interface PluginUiSchema {
  apiVersion: number;
  /** 按量计费时，数量取哪个字段的值（如 seconds） */
  priceQuantityField?: string;
  layout?: { toolbar?: string[]; body?: string[] };
  modelSelector: PluginModelSelector;
  fields: PluginField[];
}

export interface PluginPrice {
  unit: 'per-second' | 'per-call';
  amount: number;
  currency?: string;
}

export interface PluginModelInfo {
  id: string;
  name: string;
  shortName: string;
  description?: string;
  price: PluginPrice | null;
}

export interface PluginCredentialSpec {
  source: 'client';
  label: string;
  defaultBaseUrl: string;
  helpUrl?: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  kind: 'video';
  description: string;
  author: string;
  homepage: string;
  outputs: string[];
  credential: PluginCredentialSpec;
  media: Partial<Record<MediaKind, { maxCount: number }>>;
  models: PluginModelInfo[];
  uiSchema: PluginUiSchema;
}

/** 表单值：facet 取值 + 字段取值 */
export type FacetValues = Record<string, string | number>;
export type FieldValues = Record<string, string | number | boolean>;
/** 素材字段的已上传 URL（提交时用）或待上传项（编辑时用），按字段 key 分组 */
export type MediaValues<T> = Record<string, T[]>;

/** 条件求值的作用域：facet 与字段值合在一起，条件里两者都能引用。 */
export function buildScope(facets: FacetValues, fields: FieldValues): Record<string, unknown> {
  return { ...facets, ...fields };
}

export function matchCondition(condition: FacetCondition | undefined, scope: Record<string, unknown>): boolean {
  if (!condition) return true;
  for (const [key, values] of Object.entries(condition)) {
    if (!Array.isArray(values)) continue;
    const actual = scope[key];
    if (!values.some(value => String(value) === String(actual))) return false;
  }
  return true;
}

export function isFieldVisible(field: PluginField, scope: Record<string, unknown>): boolean {
  return matchCondition(field.showIf, scope);
}

export function isFieldRequired(field: PluginField, scope: Record<string, unknown>): boolean {
  if (field.required === true) return true;
  if (!field.requiredIf) return false;
  return matchCondition(field.requiredIf, scope);
}

export function isOptionAvailable(option: PluginFieldOption, scope: Record<string, unknown>): boolean {
  return matchCondition(option.availableWhen, scope);
}

/** 素材字段在当前 facet 下的名额上限。0 表示该组合不支持这类素材，界面上直接隐藏。 */
export function resolveMaxCount(field: PluginField, facets: FacetValues): number {
  const max = field.maxCount;
  if (typeof max === 'number') return Number.isInteger(max) ? max : 0;
  if (max && typeof max === 'object') {
    const value = max.values[String(facets[max.byFacet])];
    if (Number.isInteger(value)) return value;
    return Number.isInteger(max.default) ? (max.default as number) : 0;
  }
  return 0;
}

/**
 * facet 组合 → 模型 ID。组合不存在时返回 null。
 * variants 是数据，因此新增一个「漫画版 1080P」只需要给插件加一行。
 */
export function resolveModel(schema: PluginUiSchema, facets: FacetValues): string | null {
  const keys = schema.modelSelector.facets.map(facet => facet.key);
  const match = schema.modelSelector.variants.find(variant =>
    keys.every(key => String(variant[key]) === String(facets[key])));
  return match ? match.model : null;
}

/**
 * 某个 facet 在「排在它前面的 facet 保持当前取值」的前提下还有哪些取值可选。
 *
 * 只用前面的 facet 做约束，不用后面的：facet 的申报顺序就是选择的先后顺序，
 * 选中漫画版后分辨率里不该出现 1080P；反过来，当前分辨率是 1080P 也不该让
 * 漫画版这个档位变得不可选——那会让用户永远选不进去。
 */
export function availableFacetValues(
  schema: PluginUiSchema,
  facetKey: string,
  facets: FacetValues,
): (string | number)[] {
  const keys = schema.modelSelector.facets.map(facet => facet.key);
  const index = keys.indexOf(facetKey);
  const precedingKeys = index > 0 ? keys.slice(0, index) : [];
  const seen = new Set<string>();
  const result: (string | number)[] = [];
  // 按 facetOptions 的申报顺序输出，保证界面上的顺序由插件作者决定
  const declared = schema.modelSelector.facetOptions[facetKey] || [];
  for (const option of declared) {
    const exists = schema.modelSelector.variants.some(variant =>
      String(variant[facetKey]) === String(option.value)
      && precedingKeys.every(key => String(variant[key]) === String(facets[key])));
    if (exists && !seen.has(String(option.value))) {
      seen.add(String(option.value));
      result.push(option.value);
    }
  }
  return result;
}

/** 某个 facet 的全部申报取值（不受其它 facet 约束），用于「档位」这种一级选择。 */
export function allFacetOptions(schema: PluginUiSchema, facetKey: string): PluginFacetOption[] {
  return schema.modelSelector.facetOptions[facetKey] || [];
}

export function findFacetOption(
  schema: PluginUiSchema,
  facetKey: string,
  value: string | number | undefined,
): PluginFacetOption | undefined {
  return allFacetOptions(schema, facetKey).find(option => String(option.value) === String(value));
}

/**
 * 收敛 facet 组合：按申报顺序逐个检查，取值在「前面的 facet 已定」的前提下
 * 不再存在时落回第一个可用值。
 *
 * 顺序很重要：先定档位再定分辨率，所以「原版 1080P → 漫画版」应该改分辨率，
 * 而不是把用户刚选的漫画版改回原版。
 */
export function coerceFacets(schema: PluginUiSchema, facets: FacetValues): FacetValues {
  const next: FacetValues = { ...facets };
  for (const facet of schema.modelSelector.facets) {
    const available = availableFacetValues(schema, facet.key, next);
    if (available.length === 0) continue;
    if (!available.some(value => String(value) === String(next[facet.key]))) {
      next[facet.key] = available[0];
    }
  }
  return next;
}

/** 默认 facet 取值：每个 facet 取第一个仍然可用的申报值。 */
export function defaultFacets(schema: PluginUiSchema): FacetValues {
  const facets: FacetValues = {};
  for (const facet of schema.modelSelector.facets) {
    const declared = allFacetOptions(schema, facet.key);
    if (declared.length > 0) facets[facet.key] = declared[0].value;
  }
  return coerceFacets(schema, facets);
}

/** 由模型 ID 反查 facet 组合，用于历史记录的「重用参数」。 */
export function facetsFromModel(schema: PluginUiSchema, model: string): FacetValues | null {
  const variant = schema.modelSelector.variants.find(item => item.model === model);
  if (!variant) return null;
  const facets: FacetValues = {};
  for (const facet of schema.modelSelector.facets) {
    facets[facet.key] = variant[facet.key];
  }
  return facets;
}

/** 字段的默认值：声明了 default 就用它，select 类回落到第一个可用选项。 */
export function defaultFieldValues(schema: PluginUiSchema, facets: FacetValues): FieldValues {
  const fields: FieldValues = {};
  for (const field of schema.fields) {
    if (field.type === 'media') continue;
    if (field.default !== undefined) {
      fields[field.key] = field.default;
      continue;
    }
    if (field.type === 'switch') {
      fields[field.key] = false;
      continue;
    }
    if ((field.type === 'select' || field.type === 'select-grid') && field.options?.length) {
      const scope = buildScope(facets, fields);
      const first = field.options.find(option => isOptionAvailable(option, scope));
      if (first) fields[field.key] = first.value;
      continue;
    }
    if (field.type === 'text' || field.type === 'textarea') fields[field.key] = '';
  }
  return fields;
}

/**
 * facet 变化后收敛字段值：当前取值在新组合下不可选时，落到第一个可选项。
 * 不这么做的话，切到量化版后「首尾帧」会留在表单里，提交时才被后端拒绝。
 */
export function coerceFieldValues(
  schema: PluginUiSchema,
  facets: FacetValues,
  fields: FieldValues,
): FieldValues {
  const next: FieldValues = { ...fields };
  for (const field of schema.fields) {
    if (field.type !== 'select' && field.type !== 'select-grid') continue;
    const options = field.options || [];
    const scope = buildScope(facets, next);
    const current = options.find(option => String(option.value) === String(next[field.key]));
    if (current && isOptionAvailable(current, scope)) continue;
    const fallback = options.find(option => isOptionAvailable(option, scope));
    if (fallback) next[field.key] = fallback.value;
  }
  return next;
}

/** 当前组合下该字段有哪些可选项 */
export function visibleOptions(field: PluginField, scope: Record<string, unknown>): PluginFieldOption[] {
  return (field.options || []).filter(option => isOptionAvailable(option, scope));
}

export interface ResolvedMediaField {
  field: PluginField;
  maxCount: number;
  required: boolean;
}

/** 当前组合下要显示的素材槽（maxCount 为 0 的直接不显示）。 */
export function resolvedMediaFields(
  schema: PluginUiSchema,
  facets: FacetValues,
  fields: FieldValues,
): ResolvedMediaField[] {
  const scope = buildScope(facets, fields);
  const result: ResolvedMediaField[] = [];
  for (const field of schema.fields) {
    if (field.type !== 'media') continue;
    if (!isFieldVisible(field, scope)) continue;
    const maxCount = resolveMaxCount(field, facets);
    if (maxCount <= 0) continue;
    result.push({ field, maxCount, required: isFieldRequired(field, scope) });
  }
  return result;
}

/** 按 layout 顺序取出要放进工具栏的字段（`$model` / `$<facetKey>` 由调用方渲染）。 */
export function toolbarEntries(schema: PluginUiSchema): string[] {
  if (schema.layout?.toolbar?.length) return schema.layout.toolbar;
  const facetKeys = schema.modelSelector.facets.slice(1).map(facet => `$${facet.key}`);
  const fieldKeys = schema.fields
    .filter(field => field.type === 'select' || field.type === 'select-grid')
    .map(field => field.key);
  return ['$model', ...facetKeys, ...fieldKeys];
}

/** 按 layout 顺序取出要放进主体区的字段 key。 */
export function bodyEntries(schema: PluginUiSchema): string[] {
  if (schema.layout?.body?.length) return schema.layout.body;
  return schema.fields
    .filter(field => field.type === 'media' || field.type === 'text' || field.type === 'textarea' || field.type === 'switch')
    .map(field => field.key);
}

export function findField(schema: PluginUiSchema, key: string): PluginField | undefined {
  return schema.fields.find(field => field.key === key);
}

export function findModel(plugin: InstalledPlugin, modelId: string): PluginModelInfo | undefined {
  return plugin.models.find(model => model.id === modelId);
}

/**
 * 估算这一单的价格。按秒计费时数量取 `priceQuantityField` 指定的字段。
 * 插件没申报价格就返回 null，界面上整个价格标签不渲染，而不是显示 ¥0.00。
 */
export function estimateCost(
  plugin: InstalledPlugin,
  modelId: string,
  fields: FieldValues,
): number | null {
  const price = findModel(plugin, modelId)?.price;
  if (!price || !Number.isFinite(price.amount)) return null;
  if (price.unit === 'per-call') return Number(price.amount.toFixed(2));
  const key = plugin.uiSchema.priceQuantityField;
  const quantity = key ? Number(fields[key]) : NaN;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return Number((price.amount * quantity).toFixed(2));
}

/** 「标签 + 取值」一条参数快照。 */
export interface SchemaParamChip {
  label: string;
  value: string;
}

/**
 * 当前 facet/字段组合的可读快照：全部 facet + 当前可见的选项类字段。
 * 宿主工作台冻结历史记录、画布生成预览都用这一份，避免两处各写一套标签拼接。
 */
export function summarizeSchemaParams(
  plugin: InstalledPlugin,
  facets: FacetValues,
  fields: FieldValues,
): SchemaParamChip[] {
  const schema = plugin.uiSchema;
  const chips: SchemaParamChip[] = [];
  for (const facet of schema.modelSelector.facets) {
    const option = findFacetOption(schema, facet.key, facets[facet.key]);
    chips.push({
      label: facet.label,
      value: option?.fullLabel || option?.label || String(facets[facet.key] ?? ''),
    });
  }
  const scope = buildScope(facets, fields);
  for (const field of schema.fields) {
    if (field.type !== 'select' && field.type !== 'select-grid') continue;
    if (!isFieldVisible(field, scope)) continue;
    const option = (field.options || []).find(item => String(item.value) === String(fields[field.key]));
    if (!option) continue;
    chips.push({
      label: field.label || field.key,
      value: `${option.label}${field.suffix && !option.label.endsWith(field.suffix) ? field.suffix : ''}`,
    });
  }
  return chips;
}

/** 校验结果：能提交时 reason 为 null。 */
export interface SubmitCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * 提交前的即时校验，与后端 validateAndNormalizeInput 同一套规则。
 * 只用于禁用按钮和给提示，真正的把关在后端。
 */
export function checkSubmittable(
  schema: PluginUiSchema,
  facets: FacetValues,
  fields: FieldValues,
  mediaCounts: Record<string, number>,
): SubmitCheck {
  if (!resolveModel(schema, facets)) {
    return { ok: false, reason: '当前参数组合没有对应的模型' };
  }
  const scope = buildScope(facets, fields);
  for (const field of schema.fields) {
    if (!isFieldVisible(field, scope)) continue;
    const label = field.label || field.key;
    const required = isFieldRequired(field, scope);

    if (field.type === 'media') {
      const maxCount = resolveMaxCount(field, facets);
      const count = mediaCounts[field.key] || 0;
      if (maxCount <= 0) continue;
      if (count > maxCount) return { ok: false, reason: `「${label}」最多 ${maxCount} 个` };
      if (required && count === 0) return { ok: false, reason: `请先提供「${label}」` };
      continue;
    }
    if (field.type === 'text' || field.type === 'textarea') {
      const text = typeof fields[field.key] === 'string' ? String(fields[field.key]).trim() : '';
      if (required && text === '') return { ok: false, reason: `请先填写「${label}」` };
      if (field.maxLength && text.length > field.maxLength) {
        return { ok: false, reason: `「${label}」超过 ${field.maxLength} 字上限` };
      }
    }
  }
  return { ok: true, reason: null };
}
