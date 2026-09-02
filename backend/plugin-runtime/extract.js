'use strict';

/**
 * 上游响应的取值与归一化。
 *
 * 上游返回体的形状千奇百怪（`video_url` / `data[0].url` / `output.video_url` …），
 * 插件用一组候选路径描述「去哪里找」，宿主按顺序取第一个非空值。
 * 这样宿主不需要认识任何具体上游，也不必为每家上游改代码。
 */

const { getPath, isEmptyValue } = require('./template');

/** 按候选路径顺序取第一个非空值。paths 可以是单个字符串。 */
function pickFirst(source, paths) {
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  for (const path of list) {
    const value = getPath(source, path);
    if (!isEmptyValue(value)) return value;
  }
  return undefined;
}

/** 取第一个非空的字符串值；拿到的不是字符串就跳过（避免把对象 String() 成 "[object Object]"）。 */
function pickFirstString(source, paths) {
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  for (const path of list) {
    const value = getPath(source, path);
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

const TERMINAL_STATES = new Set(['completed', 'failed']);

/**
 * 用插件申报的状态词表归一化上游状态。
 *
 * 认不出来的取值按 processing 处理并打一条 warn：静默当成生成中会让「上游排队」
 * 在界面上显示成「正在渲染」，而判死又可能把一个正常任务杀掉。日志是补词表的唯一线索。
 *
 * @returns {{ state: 'queued'|'processing'|'completed'|'failed', raw: string, recognized: boolean }}
 */
function classifyStatus(payload, statusSpec, logLabel) {
  const spec = statusSpec || {};
  const raw = pickFirstString(payload, spec.from || ['status', 'state']) ?? '';
  const normalized = spec.lowercase === false ? raw : raw.toLowerCase();

  const buckets = [
    ['completed', spec.completed],
    ['failed', spec.failed],
    ['queued', spec.queued],
    ['processing', spec.processing],
  ];
  for (const [state, words] of buckets) {
    if (Array.isArray(words) && words.includes(normalized)) {
      return { state, raw: normalized, recognized: true };
    }
  }

  if (normalized !== '') {
    console.warn(`[plugin-task] 未识别的上游状态 ${logLabel || ''} status=${JSON.stringify(raw)}`);
  }
  return { state: 'processing', raw: normalized, recognized: false };
}

/**
 * 取进度百分比。
 *
 * 不做 0-1 与 0-100 的自动换算：progress=1 到底是 1% 还是 100% 无从分辨，猜错比不显示更糟。
 * 插件用 `scale` 明确申报量纲；缺字段或不是有限数时返回 undefined，由前端退回「只显示已用时间」。
 */
function extractProgress(payload, progressSpec) {
  if (!progressSpec) return undefined;
  const raw = pickFirst(payload, progressSpec.from || ['progress']);
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const percent = progressSpec.scale === '0-1' ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * 按插件申报的映射改写 URL 主机名。用于上游返回内部域名、需要换成 CDN 域名的场景。
 * 只改命中映射表的主机，其它域名原样返回，避免误改正规链接。
 */
function rewriteHost(url, rewriteMap) {
  if (typeof url !== 'string' || !url || !rewriteMap) return url;
  try {
    const parsed = new URL(url);
    const target = rewriteMap[parsed.hostname];
    if (!target) return url;
    parsed.host = target;
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 把上游响应压成宿主统一的产物结构。历史记录模块只认这一种形状，
 * 因此插件卸载后旧记录依然能预览、下载。
 *
 * @returns {{ assets: Array<{kind:string,url:string,posterUrl?:string,durationSec?:number,mime?:string}> }}
 */
function normalizeResult(payload, resultSpec, context, resolveTemplate) {
  const spec = resultSpec || {};
  const rewriteMap = spec.rewriteHosts && typeof spec.rewriteHosts === 'object' ? spec.rewriteHosts : null;
  const assets = [];

  for (const entry of Array.isArray(spec.assets) ? spec.assets : []) {
    let url = pickFirstString(payload, entry.url);
    if (!url && entry.fallbackUrl) {
      url = resolveTemplate(entry.fallbackUrl, context);
      if (typeof url !== 'string' || !url) url = undefined;
    }
    if (!url) continue;

    const poster = pickFirstString(payload, entry.posterUrl);
    const duration = pickFirst(payload, entry.durationSec);
    assets.push({
      kind: entry.kind || 'video',
      url: rewriteHost(url, rewriteMap),
      ...(poster ? { posterUrl: rewriteHost(poster, rewriteMap) } : {}),
      ...(Number.isFinite(Number(duration)) ? { durationSec: Number(duration) } : {}),
      ...(entry.mime ? { mime: entry.mime } : {}),
    });
  }

  return { assets };
}

/** 上游错误文案。找不到就返回 undefined，由调用方补通用文案。 */
function extractError(payload, errorSpec) {
  return pickFirstString(payload, (errorSpec && errorSpec.from) || [
    'error.message', 'error.msg', 'error', 'message', 'msg', 'detail',
  ]);
}

module.exports = {
  pickFirst,
  pickFirstString,
  classifyStatus,
  extractProgress,
  rewriteHost,
  normalizeResult,
  extractError,
  TERMINAL_STATES,
};
