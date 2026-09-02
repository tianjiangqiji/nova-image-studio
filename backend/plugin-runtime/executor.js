'use strict';

/**
 * 插件执行体：按 provider.json 向上游发一次创建请求 / 一次查询请求。
 *
 * 这里不含任何调度逻辑——排队、并发名额、轮询循环、超时判死都在 server.js 里，
 * 与内置图片任务共用同一套队列。执行体只负责「把模板变成一次 HTTP 调用，再把响应压成归一化结果」。
 */

const { resolveTemplate } = require('./template');
const { classifyStatus, extractProgress, normalizeResult, extractError, pickFirstString } = require('./extract');
const { isHostAllowed } = require('./registry');

const DEFAULT_SUBMIT_TIMEOUT_MS = 90 * 1000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 12 * 1000;
const DEFAULT_MAX_POLL_MS = 30 * 60 * 1000;

/** 内网 / 环回地址一律拒绝：插件模板不能被拿来当内网探测器（SSRF）。 */
function isLocallyScopedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

class PluginRequestError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.name = 'PluginRequestError';
    this.fatal = fatal;
  }
}

/**
 * 出网前的统一闸门：协议必须是 https（或显式允许 http 的场景由 allowlist 承担），
 * 主机必须在 manifest.permissions.hosts 里，且不能是内网地址。
 */
function assertUrlAllowed(plugin, url, what) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new PluginRequestError(`插件 ${plugin.id} 的${what}地址不是合法 URL: ${url}`, { fatal: true });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PluginRequestError(`插件 ${plugin.id} 的${what}只允许 http/https 协议`, { fatal: true });
  }
  if (isLocallyScopedHost(parsed.hostname)) {
    throw new PluginRequestError(`插件 ${plugin.id} 不能访问内网地址 ${parsed.hostname}`, { fatal: true });
  }
  if (!isHostAllowed(plugin, parsed.toString())) {
    throw new PluginRequestError(
      `插件 ${plugin.id} 未在 manifest.permissions.hosts 中申报主机 ${parsed.hostname}`,
      { fatal: true },
    );
  }
  return parsed.toString();
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 构造模板上下文。apiKey 只在这里出现一次，日志与入库都不会带上它。
 */
function buildContext({ plugin, baseUrl, apiKey, model, facets, fields, media, upstreamTaskId, publicBaseUrl }) {
  return {
    baseUrl: normalizeBaseUrl(baseUrl || (plugin.manifest.credential.defaultBaseUrl || '')),
    apiKey: String(apiKey || ''),
    model: String(model || ''),
    facet: { ...(facets || {}) },
    fields: { ...(fields || {}) },
    media: { ...(media || {}) },
    upstreamTaskId: upstreamTaskId ? String(upstreamTaskId) : '',
    publicBaseUrl: normalizeBaseUrl(publicBaseUrl || ''),
    pluginId: plugin.id,
    pluginVersion: plugin.manifest.version,
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonSafely(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 响应体不是 JSON 时截一段原文出来，比「上游错误 (500)」有用得多。 */
function summarizeBody(text) {
  const trimmed = String(text || '').trim();
  if (trimmed === '') return '';
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function resolveRequest(spec, context, plugin, what) {
  const url = assertUrlAllowed(plugin, resolveTemplate(spec.url, context), what);
  const method = String(spec.method || 'GET').toUpperCase();
  const headers = {};
  for (const [key, value] of Object.entries(resolveTemplate(spec.headers || {}, context))) {
    headers[key] = String(value);
  }
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && spec.body !== undefined) {
    const body = resolveTemplate(spec.body, context);
    init.body = JSON.stringify(body);
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return { url, init };
}

/**
 * 创建上游任务。
 *
 * @returns {Promise<{ upstreamTaskId: string, immediate?: { state: string, assets: object[] } }>}
 * @throws {PluginRequestError}
 */
async function submitTask(plugin, context) {
  const spec = plugin.provider.submit;
  const timeoutMs = Number(spec.timeoutMs)
    || Number(plugin.manifest.runtime && plugin.manifest.runtime.submitTimeoutMs)
    || DEFAULT_SUBMIT_TIMEOUT_MS;

  const { url, init } = resolveRequest(spec, context, plugin, '创建请求');
  const response = await fetchWithTimeout(url, init, timeoutMs);
  const text = await response.text();
  const payload = parseJsonSafely(text);

  if (!response.ok || !payload) {
    const message = extractError(payload, spec.error)
      || summarizeBody(text)
      || `上游创建任务失败 (${response.status})`;
    throw new PluginRequestError(message, { fatal: true });
  }

  const upstreamTaskId = pickFirstString(payload, spec.extract.taskId);
  if (!upstreamTaskId) {
    throw new PluginRequestError('上游未返回任务 ID', { fatal: true });
  }

  // 少数上游在创建那一刻就直接给出成品，省掉一整轮轮询
  const result = { upstreamTaskId };
  const pollSpec = plugin.provider.poll;
  const status = classifyStatus(payload, pollSpec.status, `${plugin.id}/submit`);
  if (status.state === 'completed') {
    const immediateContext = { ...context, upstreamTaskId };
    const normalized = normalizeResult(payload, pollSpec.result, immediateContext, resolveTemplate);
    if (normalized.assets.length > 0) {
      result.immediate = { state: 'completed', assets: normalized.assets };
    }
  }
  return result;
}

/**
 * 把一次查询响应压成归一化结果。
 *
 * 单独抽出来是为了让离线自检（verify.js 跑 fixtures）走的是与线上完全同一条路径——
 * 否则 fixtures 验证的只是「另一份实现的行为」，价值大打折扣。
 *
 * @returns {{ state:'queued'|'processing'|'completed'|'failed', progress?: number, assets?: object[], error?: string }}
 */
function normalizePollResponse(plugin, payload, context) {
  const spec = plugin.provider.poll;
  const status = classifyStatus(payload, spec.status, `${plugin.id}/${context.upstreamTaskId}`);
  const progress = extractProgress(payload, spec.progress);

  if (status.state === 'completed') {
    const normalized = normalizeResult(payload, spec.result, context, resolveTemplate);
    if (normalized.assets.length === 0) {
      return { state: 'failed', progress: 100, error: '上游报告完成但没有返回可用的产物地址' };
    }
    // 上游偶尔在 completed 那一帧仍回 progress<100，补齐，免得进度条停在 97% 却已出片
    return { state: 'completed', progress: 100, assets: normalized.assets };
  }

  if (status.state === 'failed') {
    return {
      state: 'failed',
      ...(progress !== undefined ? { progress } : {}),
      error: extractError(payload, spec.error) || '生成失败',
    };
  }

  return { state: status.state, ...(progress !== undefined ? { progress } : {}) };
}

/**
 * 查询一次上游状态。
 *
 * 请求本身失败时不判死：5xx 与网络抖动很常见，交由调用方在下一轮重试；
 * 只有 provider 申报的 fatalHttpStatus（通常 400/401/403）才认定任务已经死了。
 */
async function pollTask(plugin, context) {
  const spec = plugin.provider.poll;
  const timeoutMs = Number(spec.timeoutMs) || DEFAULT_POLL_TIMEOUT_MS;
  const { url, init } = resolveRequest(spec, context, plugin, '查询请求');

  const response = await fetchWithTimeout(url, init, timeoutMs);
  const text = await response.text();
  const payload = parseJsonSafely(text);

  if (!response.ok || !payload) {
    const fatalCodes = Array.isArray(spec.fatalHttpStatus) ? spec.fatalHttpStatus : [400, 401, 403];
    const message = extractError(payload, spec.error)
      || summarizeBody(text)
      || `上游错误 (${response.status})`;
    if (fatalCodes.includes(response.status)) {
      return { state: 'failed', error: message };
    }
    // 非致命：保持 processing，本轮不更新进度
    return { state: 'processing' };
  }

  return normalizePollResponse(plugin, payload, context);
}

/** 轮询节奏：provider 优先，其次 manifest.runtime，最后宿主默认值。 */
function resolvePollTiming(plugin) {
  const provider = plugin.provider.poll || {};
  const runtime = plugin.manifest.runtime || {};
  const clamp = (value, fallback, min, max) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.round(num)));
  };
  return {
    intervalMs: clamp(
      provider.intervalMs ?? runtime.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      2000,
      5 * 60 * 1000,
    ),
    maxTotalMs: clamp(
      provider.maxTotalMs ?? runtime.maxPollMs,
      DEFAULT_MAX_POLL_MS,
      60 * 1000,
      6 * 60 * 60 * 1000,
    ),
  };
}

module.exports = {
  PluginRequestError,
  buildContext,
  submitTask,
  pollTask,
  normalizePollResponse,
  resolvePollTiming,
  isLocallyScopedHost,
  assertUrlAllowed,
};
