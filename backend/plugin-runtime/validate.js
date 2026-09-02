'use strict';

/**
 * 插件包的结构校验。
 *
 * 校验失败不会让服务器起不来——插件只是被标成「加载失败」并把原因透给设置页，
 * 管理员在界面上就能看到是哪一个文件的哪个字段写错了。
 */

const PLUGIN_API_VERSION = 1;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const MEDIA_KINDS = ['images', 'videos', 'audios'];
const FIELD_TYPES = ['textarea', 'text', 'select', 'select-grid', 'media', 'switch'];
const PRICE_UNITS = ['per-second', 'per-call'];

class ValidationErrors {
  constructor() { this.messages = []; }
  add(message) { this.messages.push(message); return this; }
  get ok() { return this.messages.length === 0; }
  get message() { return this.messages.join('；'); }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** manifest.json */
function validateManifest(manifest, dirName, errors) {
  if (!isPlainObject(manifest)) return errors.add('manifest.json 必须是一个 JSON 对象');

  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    errors.add(`manifest.apiVersion 必须为 ${PLUGIN_API_VERSION}（当前 ${JSON.stringify(manifest.apiVersion)}）`);
  }
  if (!PLUGIN_ID_PATTERN.test(String(manifest.id || ''))) {
    errors.add('manifest.id 只能包含小写字母、数字与短横线，长度 2-64');
  } else if (dirName && manifest.id !== dirName) {
    errors.add(`manifest.id (${manifest.id}) 必须与插件目录名 (${dirName}) 一致`);
  }
  if (!isNonEmptyString(manifest.name)) errors.add('manifest.name 不能为空');
  if (!SEMVER_PATTERN.test(String(manifest.version || ''))) {
    errors.add('manifest.version 必须是语义化版本，如 1.0.0');
  }
  if (manifest.kind !== 'video') errors.add('manifest.kind 目前只支持 "video"');
  if (manifest.mode !== undefined && manifest.mode !== 'declarative') {
    errors.add('manifest.mode 目前只支持 "declarative"');
  }

  const credential = manifest.credential;
  if (!isPlainObject(credential)) {
    errors.add('manifest.credential 缺失');
  } else {
    if (credential.source !== 'client') errors.add('manifest.credential.source 目前只支持 "client"');
    if (!isNonEmptyString(credential.label)) errors.add('manifest.credential.label 不能为空');
    if (credential.defaultBaseUrl !== undefined && !isNonEmptyString(credential.defaultBaseUrl)) {
      errors.add('manifest.credential.defaultBaseUrl 必须是字符串');
    }
  }

  const hosts = manifest.permissions && manifest.permissions.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    errors.add('manifest.permissions.hosts 至少要申报一个允许访问的主机名');
  } else {
    for (const host of hosts) {
      if (!isNonEmptyString(host) || !HOSTNAME_PATTERN.test(host)) {
        errors.add(`manifest.permissions.hosts 含非法主机名: ${JSON.stringify(host)}`);
      }
    }
  }

  if (manifest.media !== undefined) {
    if (!isPlainObject(manifest.media)) {
      errors.add('manifest.media 必须是对象');
    } else {
      for (const [kind, rule] of Object.entries(manifest.media)) {
        if (!MEDIA_KINDS.includes(kind)) {
          errors.add(`manifest.media 含未知素材类型: ${kind}（可选 ${MEDIA_KINDS.join(' / ')}）`);
        } else if (!isPlainObject(rule) || !Number.isInteger(rule.maxCount) || rule.maxCount < 0) {
          errors.add(`manifest.media.${kind}.maxCount 必须是非负整数`);
        }
      }
    }
  }

  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    errors.add('manifest.models 至少要有一个模型');
  } else {
    const seen = new Set();
    manifest.models.forEach((model, index) => {
      const at = `manifest.models[${index}]`;
      if (!isPlainObject(model)) return void errors.add(`${at} 必须是对象`);
      if (!isNonEmptyString(model.id)) errors.add(`${at}.id 不能为空`);
      else if (seen.has(model.id)) errors.add(`${at}.id 重复: ${model.id}`);
      else seen.add(model.id);
      if (!isNonEmptyString(model.name)) errors.add(`${at}.name 不能为空`);
      if (model.price !== undefined) {
        if (!isPlainObject(model.price)) {
          errors.add(`${at}.price 必须是对象`);
        } else {
          if (!PRICE_UNITS.includes(model.price.unit)) {
            errors.add(`${at}.price.unit 必须是 ${PRICE_UNITS.join(' 或 ')}`);
          }
          if (typeof model.price.amount !== 'number' || !(model.price.amount >= 0)) {
            errors.add(`${at}.price.amount 必须是非负数字`);
          }
        }
      }
    });
  }

  return errors;
}

/** 校验 showIf / availableWhen / requiredIf 这类 facet 条件对象 */
function validateCondition(condition, at, errors) {
  if (!isPlainObject(condition)) return void errors.add(`${at} 必须是对象，形如 { "tier": ["standard"] }`);
  for (const [key, values] of Object.entries(condition)) {
    if (!isNonEmptyString(key)) errors.add(`${at} 的键不能为空`);
    if (!Array.isArray(values) || values.length === 0) {
      errors.add(`${at}.${key} 必须是非空数组`);
    }
  }
}

/** ui.schema.json */
function validateUiSchema(schema, manifest, errors) {
  if (!isPlainObject(schema)) return errors.add('ui.schema.json 必须是一个 JSON 对象');
  if (schema.apiVersion !== PLUGIN_API_VERSION) {
    errors.add(`ui.schema.apiVersion 必须为 ${PLUGIN_API_VERSION}`);
  }

  const modelIds = new Set(
    (Array.isArray(manifest && manifest.models) ? manifest.models : [])
      .map(model => model && model.id)
      .filter(Boolean),
  );

  const selector = schema.modelSelector;
  const facetKeys = new Set();
  if (!isPlainObject(selector)) {
    errors.add('ui.schema.modelSelector 缺失');
  } else {
    if (!Array.isArray(selector.facets) || selector.facets.length === 0) {
      errors.add('ui.schema.modelSelector.facets 至少要有一个 facet');
    } else {
      selector.facets.forEach((facet, index) => {
        const at = `ui.schema.modelSelector.facets[${index}]`;
        if (!isPlainObject(facet)) return void errors.add(`${at} 必须是对象`);
        if (!isNonEmptyString(facet.key)) errors.add(`${at}.key 不能为空`);
        else if (facetKeys.has(facet.key)) errors.add(`${at}.key 重复: ${facet.key}`);
        else facetKeys.add(facet.key);
        if (!isNonEmptyString(facet.label)) errors.add(`${at}.label 不能为空`);
        const options = selector.facetOptions && selector.facetOptions[facet.key];
        if (!Array.isArray(options) || options.length === 0) {
          errors.add(`ui.schema.modelSelector.facetOptions.${facet.key} 至少要有一个选项`);
        } else {
          options.forEach((option, optionIndex) => {
            const optionAt = `ui.schema.modelSelector.facetOptions.${facet.key}[${optionIndex}]`;
            if (!isPlainObject(option)) return void errors.add(`${optionAt} 必须是对象`);
            if (option.value === undefined || option.value === null || option.value === '') {
              errors.add(`${optionAt}.value 不能为空`);
            }
            if (!isNonEmptyString(option.label)) errors.add(`${optionAt}.label 不能为空`);
          });
        }
      });
    }

    if (!Array.isArray(selector.variants) || selector.variants.length === 0) {
      errors.add('ui.schema.modelSelector.variants 至少要有一个变体');
    } else {
      selector.variants.forEach((variant, index) => {
        const at = `ui.schema.modelSelector.variants[${index}]`;
        if (!isPlainObject(variant)) return void errors.add(`${at} 必须是对象`);
        if (!isNonEmptyString(variant.model)) {
          errors.add(`${at}.model 不能为空`);
        } else if (modelIds.size > 0 && !modelIds.has(variant.model)) {
          errors.add(`${at}.model (${variant.model}) 未在 manifest.models 中申报`);
        }
        for (const key of facetKeys) {
          if (variant[key] === undefined) errors.add(`${at} 缺少 facet「${key}」的取值`);
        }
      });
    }
  }

  const fieldKeys = new Set();
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  if (fields.length === 0) errors.add('ui.schema.fields 至少要有一个字段');
  fields.forEach((field, index) => {
    const at = `ui.schema.fields[${index}]`;
    if (!isPlainObject(field)) return void errors.add(`${at} 必须是对象`);
    if (!isNonEmptyString(field.key)) errors.add(`${at}.key 不能为空`);
    else if (fieldKeys.has(field.key)) errors.add(`${at}.key 重复: ${field.key}`);
    else if (facetKeys.has(field.key)) errors.add(`${at}.key (${field.key}) 与 facet 同名`);
    else fieldKeys.add(field.key);

    if (!FIELD_TYPES.includes(field.type)) {
      errors.add(`${at}.type 必须是 ${FIELD_TYPES.join(' / ')} 之一`);
    }
    if (field.showIf !== undefined) validateCondition(field.showIf, `${at}.showIf`, errors);
    if (field.requiredIf !== undefined) validateCondition(field.requiredIf, `${at}.requiredIf`, errors);

    if (field.type === 'select' || field.type === 'select-grid') {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        errors.add(`${at}.options 至少要有一个选项`);
      } else {
        field.options.forEach((option, optionIndex) => {
          const optionAt = `${at}.options[${optionIndex}]`;
          if (!isPlainObject(option)) return void errors.add(`${optionAt} 必须是对象`);
          if (option.value === undefined || option.value === null || option.value === '') {
            errors.add(`${optionAt}.value 不能为空`);
          }
          if (option.availableWhen !== undefined) {
            validateCondition(option.availableWhen, `${optionAt}.availableWhen`, errors);
          }
        });
      }
    }

    if (field.type === 'media') {
      if (!MEDIA_KINDS.includes(field.kind)) {
        errors.add(`${at}.kind 必须是 ${MEDIA_KINDS.join(' / ')} 之一`);
      }
      const max = field.maxCount;
      if (Number.isInteger(max)) {
        if (max < 0) errors.add(`${at}.maxCount 不能为负`);
      } else if (isPlainObject(max)) {
        if (!isNonEmptyString(max.byFacet)) {
          errors.add(`${at}.maxCount.byFacet 不能为空`);
        } else if (facetKeys.size > 0 && !facetKeys.has(max.byFacet)) {
          errors.add(`${at}.maxCount.byFacet (${max.byFacet}) 不是已申报的 facet`);
        }
        if (!isPlainObject(max.values)) errors.add(`${at}.maxCount.values 必须是对象`);
      } else {
        errors.add(`${at}.maxCount 必须是整数或 { byFacet, values, default }`);
      }
    }
  });

  return errors;
}

/** provider.json */
function validateProvider(provider, manifest, errors) {
  if (!isPlainObject(provider)) return errors.add('provider.json 必须是一个 JSON 对象');
  if (provider.apiVersion !== PLUGIN_API_VERSION) {
    errors.add(`provider.apiVersion 必须为 ${PLUGIN_API_VERSION}`);
  }

  const submit = provider.submit;
  if (!isPlainObject(submit)) {
    errors.add('provider.submit 缺失');
  } else {
    if (!isNonEmptyString(submit.url)) errors.add('provider.submit.url 不能为空');
    if (submit.method !== undefined && !isNonEmptyString(submit.method)) {
      errors.add('provider.submit.method 必须是字符串');
    }
    const taskId = submit.extract && submit.extract.taskId;
    const hasTaskId = isNonEmptyString(taskId) || (Array.isArray(taskId) && taskId.length > 0);
    if (!hasTaskId) {
      errors.add('provider.submit.extract.taskId 必须给出上游任务 ID 的候选路径');
    }
  }

  const poll = provider.poll;
  if (!isPlainObject(poll)) {
    errors.add('provider.poll 缺失');
  } else {
    if (!isNonEmptyString(poll.url)) errors.add('provider.poll.url 不能为空');
    const status = poll.status;
    if (!isPlainObject(status)) {
      errors.add('provider.poll.status 缺失');
    } else {
      for (const key of ['completed', 'failed']) {
        if (!Array.isArray(status[key]) || status[key].length === 0) {
          errors.add(`provider.poll.status.${key} 至少要列出一个上游状态词`);
        }
      }
      for (const key of ['queued', 'processing']) {
        if (status[key] !== undefined && !Array.isArray(status[key])) {
          errors.add(`provider.poll.status.${key} 必须是数组`);
        }
      }
    }
    if (poll.progress !== undefined) {
      if (!isPlainObject(poll.progress)) {
        errors.add('provider.poll.progress 必须是对象');
      } else if (poll.progress.scale !== undefined && !['0-1', '0-100'].includes(poll.progress.scale)) {
        errors.add('provider.poll.progress.scale 必须是 "0-1" 或 "0-100"');
      }
    }

    const result = poll.result;
    if (!isPlainObject(result) || !Array.isArray(result.assets) || result.assets.length === 0) {
      errors.add('provider.poll.result.assets 至少要描述一个产物');
    } else {
      result.assets.forEach((asset, index) => {
        const at = `provider.poll.result.assets[${index}]`;
        if (!isPlainObject(asset)) return void errors.add(`${at} 必须是对象`);
        const hasUrl = isNonEmptyString(asset.url) || (Array.isArray(asset.url) && asset.url.length > 0);
        if (!hasUrl && !isNonEmptyString(asset.fallbackUrl)) {
          errors.add(`${at} 必须给出 url 候选路径或 fallbackUrl`);
        }
      });
      if (result.rewriteHosts !== undefined && !isPlainObject(result.rewriteHosts)) {
        errors.add('provider.poll.result.rewriteHosts 必须是对象');
      }
    }
    if (poll.fatalHttpStatus !== undefined && !Array.isArray(poll.fatalHttpStatus)) {
      errors.add('provider.poll.fatalHttpStatus 必须是数组');
    }
  }

  // 模板里出现的模型必须来自 manifest：拼错模型名的报错比上游返回 400 好懂得多
  if (manifest && Array.isArray(manifest.models)) {
    const declared = new Set(manifest.models.map(model => model && model.id).filter(Boolean));
    const literalModel = submit && submit.body && submit.body.model;
    if (isNonEmptyString(literalModel) && !literalModel.includes('{{') && !declared.has(literalModel)) {
      errors.add(`provider.submit.body.model (${literalModel}) 未在 manifest.models 中申报`);
    }
  }

  return errors;
}

/**
 * 整包校验。
 * @returns {{ ok: boolean, message: string, messages: string[] }}
 */
function validatePluginPackage({ manifest, uiSchema, provider, dirName }) {
  const errors = new ValidationErrors();
  validateManifest(manifest, dirName, errors);
  validateUiSchema(uiSchema, manifest, errors);
  validateProvider(provider, manifest, errors);
  return { ok: errors.ok, message: errors.message, messages: errors.messages };
}

module.exports = {
  PLUGIN_API_VERSION,
  MEDIA_KINDS,
  FIELD_TYPES,
  validatePluginPackage,
  validateManifest,
  validateUiSchema,
  validateProvider,
};
