'use strict';

/**
 * 用 ui.schema 校验前端提交的表单值，并把「facet 组合」反解成要提交给上游的模型 ID。
 *
 * 前端也做同一套判断（frontend/src/lib/plugin-schema.ts），但那只是为了即时反馈。
 * 这里是唯一权威：Node 与 TS 之间没法共享一份实现，宁可写两遍也不能让后端信任前端的入参。
 */

const { MEDIA_KINDS } = require('./validate');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginInputError';
  }
}

/** 条件对象的求值作用域：facet 与字段值合在一起，条件里两者都能引用。 */
function buildScope(facets, fields) {
  return { ...facets, ...fields };
}

/**
 * 条件求值：`{ "mode": ["first-last-frame"], "tier": ["standard","comic"] }`
 * 所有键都要命中（AND），单个键内是任一命中（OR）。空条件视为成立。
 */
function matchCondition(condition, scope) {
  if (!isPlainObject(condition)) return true;
  for (const [key, values] of Object.entries(condition)) {
    if (!Array.isArray(values)) continue;
    const actual = scope[key];
    if (!values.some(value => String(value) === String(actual))) return false;
  }
  return true;
}

/** 该字段在当前 facet / 字段组合下是否可见。不可见的字段不校验、不提交。 */
function isFieldVisible(field, scope) {
  return matchCondition(field.showIf, scope);
}

function isFieldRequired(field, scope) {
  if (field.required === true) return true;
  return field.requiredIf !== undefined && matchCondition(field.requiredIf, scope);
}

/** 素材字段的名额上限：整数，或按某个 facet 取值的映射。 */
function resolveMaxCount(field, facets) {
  const max = field.maxCount;
  if (Number.isInteger(max)) return max;
  if (isPlainObject(max)) {
    const key = String(facets[max.byFacet]);
    const value = isPlainObject(max.values) ? max.values[key] : undefined;
    if (Number.isInteger(value)) return value;
    return Number.isInteger(max.default) ? max.default : 0;
  }
  return 0;
}

/** 选项在当前组合下是否可选 */
function isOptionAvailable(option, scope) {
  return matchCondition(option.availableWhen, scope);
}

/**
 * 按 facet 组合反解模型 ID。
 * variants 是一张扁平表，因此 facet 之间的组合关系是数据而不是代码。
 */
function resolveModelFromFacets(uiSchema, facets) {
  const variants = uiSchema.modelSelector.variants;
  const facetKeys = uiSchema.modelSelector.facets.map(facet => facet.key);
  const match = variants.find(variant =>
    facetKeys.every(key => String(variant[key]) === String(facets[key])));
  return match ? match.model : null;
}

/** 素材 URL 必须是本机 /api/nova/plugin-media/ 地址：不允许插件用任意外链绕过素材管理。 */
function isLocalMediaUrl(url) {
  return typeof url === 'string' && /\/api\/nova\/plugin-media\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url);
}

/**
 * 校验并归一化一次提交。
 *
 * @param {object} plugin registry 里的插件对象
 * @param {object} input `{ model, facets, fields, media }`
 * @returns {{ model: string, facets: object, fields: object, media: object, mediaUrls: string[] }}
 * @throws {InputError} 任何一项不合规
 */
function validateAndNormalizeInput(plugin, input) {
  const { manifest, uiSchema } = plugin;
  const selector = uiSchema.modelSelector;

  const rawFacets = isPlainObject(input.facets) ? input.facets : {};
  const rawFields = isPlainObject(input.fields) ? input.fields : {};
  const rawMedia = isPlainObject(input.media) ? input.media : {};

  // 1. facet：每个 facet 都必须给出一个已申报的取值
  const facets = {};
  for (const facet of selector.facets) {
    const options = selector.facetOptions[facet.key];
    const value = rawFacets[facet.key];
    const option = options.find(item => String(item.value) === String(value));
    if (!option) {
      throw new InputError(`参数「${facet.label}」的取值无效: ${JSON.stringify(value)}`);
    }
    facets[facet.key] = option.value;
  }

  // 2. 模型：facet 组合必须落在 variants 表里，且与前端声明的 model 一致
  const resolvedModel = resolveModelFromFacets(uiSchema, facets);
  if (!resolvedModel) {
    throw new InputError('当前参数组合没有对应的模型，请重新选择');
  }
  if (input.model !== undefined && input.model !== null && String(input.model) !== resolvedModel) {
    throw new InputError(`模型与参数组合不匹配：期望 ${resolvedModel}，收到 ${input.model}`);
  }
  if (!manifest.models.some(model => model.id === resolvedModel)) {
    throw new InputError(`模型 ${resolvedModel} 未在插件中申报`);
  }

  // 3. 字段：只处理当前可见的字段；不可见的一律丢弃，避免切档位后残留的旧值被提交上去
  const fields = {};
  const media = {};
  const mediaUrls = [];
  const mediaCountByKind = {};

  const scopeForVisibility = buildScope(facets, rawFields);

  for (const field of Array.isArray(uiSchema.fields) ? uiSchema.fields : []) {
    if (!isFieldVisible(field, scopeForVisibility)) continue;
    const required = isFieldRequired(field, scopeForVisibility);
    const label = field.label || field.key;

    if (field.type === 'media') {
      const maxCount = resolveMaxCount(field, facets);
      const list = Array.isArray(rawMedia[field.key]) ? rawMedia[field.key] : [];
      if (list.length > maxCount) {
        throw new InputError(`「${label}」最多 ${maxCount} 个，收到 ${list.length} 个`);
      }
      for (const url of list) {
        if (!isLocalMediaUrl(url)) {
          throw new InputError(`「${label}」含无效的素材地址`);
        }
      }
      if (required && list.length === 0) {
        throw new InputError(`「${label}」为必填项`);
      }
      if (list.length > 0) {
        media[field.key] = list;
        mediaUrls.push(...list);
        mediaCountByKind[field.kind] = (mediaCountByKind[field.kind] || 0) + list.length;
      }
      continue;
    }

    const raw = rawFields[field.key];

    if (field.type === 'switch') {
      fields[field.key] = raw === true;
      continue;
    }

    if (field.type === 'select' || field.type === 'select-grid') {
      const option = field.options.find(item => String(item.value) === String(raw));
      if (!option) {
        throw new InputError(`参数「${label}」的取值无效: ${JSON.stringify(raw)}`);
      }
      if (!isOptionAvailable(option, scopeForVisibility)) {
        throw new InputError(`当前组合下不支持「${label}」= ${option.label || option.value}`);
      }
      fields[field.key] = option.value;
      continue;
    }

    // text / textarea
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (required) throw new InputError(`「${label}」不能为空`);
      continue;
    }
    const maxLength = Number.isInteger(field.maxLength) ? field.maxLength : 0;
    if (maxLength > 0 && text.length > maxLength) {
      throw new InputError(`「${label}」超过 ${maxLength} 字上限`);
    }
    fields[field.key] = text;
  }

  // 4. 素材总量不得超过 manifest 申报的配额（schema 与 manifest 各写一处，两边都拦）
  for (const kind of MEDIA_KINDS) {
    const declared = manifest.media && manifest.media[kind];
    const used = mediaCountByKind[kind] || 0;
    if (used === 0) continue;
    if (!declared || !Number.isInteger(declared.maxCount) || used > declared.maxCount) {
      throw new InputError(`${kind} 素材数量超过插件申报的配额`);
    }
  }

  return { model: resolvedModel, facets, fields, media, mediaUrls };
}

module.exports = {
  InputError,
  validateAndNormalizeInput,
  resolveModelFromFacets,
  resolveMaxCount,
  matchCondition,
  isFieldVisible,
  isFieldRequired,
  isOptionAvailable,
  isLocalMediaUrl,
};
