const http = require('http');
const net = require('net');
const { createHash, randomUUID, timingSafeEqual } = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const next = process.env.NODE_ENV !== 'production' ? require('next') : null;
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const { CdpError, getCdpStatus, listPageTargets, evaluateInPage, capturePageScreenshot, fetchResourceInPage, openTarget, normalizeCdpHost } = require('./cdp');
const { TAOBAO_EXTRACT_EXPRESSION } = require('./taobao-extract');
const { buildDoubaoImagesUrl, resolveDoubaoImageSize, buildDoubaoImagePayload, DEFAULT_ARK_BASE_URL } = require('./doubao');
const { buildDashScopeImageUrl, buildDashScopeImagePayload, extractDashScopeImageUrl, DEFAULT_DASHSCOPE_BASE_URL } = require('./alibaba-dashscope');

// 视频插件系统。协议细节（发什么请求、怎么轮询、结果在哪）全在 backend/plugins/<id>/ 的
// JSON 里，这里只负责调度与生命周期，与内置图片任务共用同一套队列。见 docs/plugins/。
const pluginRegistry = require('./plugin-runtime/registry');
const pluginExecutor = require('./plugin-runtime/executor');
const { validateAndNormalizeInput, InputError } = require('./plugin-runtime/input');
const { createMediaStore } = require('./plugin-runtime/media');

const ENV_FILE_PATH = path.join(process.cwd(), '.env');
const TASK_STATUS = {
  QUEUED: '排队中',
  LEGACY_QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};
const GLOBAL_TASK_CONCURRENCY = 50;
const DEFAULT_LIMIT_CONFIG = {
  maxQueueSize: 200,
  rateLimitWindowMs: 60 * 1000,
  maxRequestsPerIp: 20,
  maxRequestsPerApiKey: 20,
  maxPendingTasksPerIp: 20,
  maxPendingTasksPerApiKey: 10,
  retryAfterSeconds: 30,
};
const LIMIT_ERROR_MESSAGES = {
  queueFull: '当前排队任务较多，请稍后再试。',
  rateLimited: '请求太频繁，请稍后再试。',
  tooManyPending: '你已有较多任务正在排队或生成，请稍后再提交。',
  notAcceptingTasks: '服务器正在升级维护，暂不接受新任务。未完成任务将继续完成。',
};

function parseEnvFile(filePath = ENV_FILE_PATH) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

// .env 运行期读取加 1 秒 TTL 缓存：原本每次调用都同步 readFileSync，而
// getQueueStats / 建任务 / 队列广播 / WS 订阅 / 出图前都走它（单次 getQueueStats
// 触发 3 次读盘），在事件循环上造成不必要的同步 IO。1 秒对"改 .env 实时生效"
// 而言对人类无感，符合 README 承诺。
let _runtimeEnvCache = { values: null, expiresAt: 0 };

function getRuntimeEnv() {
  const now = Date.now();
  if (!_runtimeEnvCache.values || now >= _runtimeEnvCache.expiresAt) {
    _runtimeEnvCache = {
      values: { ...process.env, ...parseEnvFile() },
      expiresAt: now + 1000,
    };
  }
  return _runtimeEnvCache.values;
}

function loadEnvFile() {
  const values = parseEnvFile();
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeProtocolBaseUrl(protocol, url) {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return '';
  if (protocol === 'google' || protocol === 'google-gemini') {
    return normalized.endsWith('/v1beta') ? normalized.slice(0, -7) : normalized;
  }
  // alibaba-dashscope 的后缀形态（/compatible-mode/v1、/api/v1、/compatible-mode/api/v1）
  // 由 buildDashScopeImageUrl 统一剥离；这里先剥一层 /v1 会产生 /compatible-mode/api
  // 之类的半截形态，让那边怎么都剥不干净（拼出 /api/api/v1/... 404）。
  if (protocol === 'alibaba-dashscope') return normalized;
  return normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
}

function resolveNovaApiBaseUrl() {
  return normalizeBaseUrl(getRuntimeEnv().NOVA_API_BASE_URL) || 'https://api.openai.com';
}

function hashPromptGalleryPassword(password) {
  return createHash('sha256')
    .update(`${PROMPT_GALLERY_PASSWORD_SALT}${String(password || '')}`)
    .digest('hex');
}

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const DB_PATH = process.env.NOVA_TASK_DB || path.join(__dirname, 'nova-tasks.sqlite');
const TASK_TTL_MS = (Number(process.env.NOVA_TASK_TTL_HOURS) || 12) * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IMAGE_STREAM_ENABLED = String(process.env.NOVA_IMAGE_STREAM ?? 'true').toLowerCase() !== 'false';
const IMAGE_STREAM_PARTIAL_IMAGES = Math.min(3, Math.max(0, Number.parseInt(process.env.NOVA_IMAGE_PARTIAL_IMAGES || '1', 10) || 1));
const IMAGE_STREAM_UNSUPPORTED_PATTERN = /(?:(?:stream|partial_images).*(?:unsupported|not supported|unknown|unrecognized|invalid)|(?:unsupported|not supported|unknown|unrecognized|invalid).*(?:stream|partial_images)|(?:stream|partial_images).*(?:不支持|未知|无效)|(?:不支持|未知|无效).*(?:stream|partial_images))/i;
// 开源版：不再硬编码模型列表，由前端通过 protocol 字段指定协议类型
const VALID_PROTOCOLS = new Set(['google', 'openai', 'grok', 'doubao', 'alibaba-dashscope']);
const GPT_IMAGE_QUALITIES = new Set(['auto', 'high', 'medium', 'low']);
const GPT_IMAGE_STYLES = new Set(['auto', 'vivid', 'natural']);
const GPT_IMAGE_BACKGROUNDS = new Set(['auto', 'transparent', 'opaque']);
const DEFAULT_GPT_IMAGE_ADVANCED_PARAMS = {
  quality: 'auto',
  style: 'auto',
  background: 'auto',
};
const PROMPT_GALLERY_PASSWORD_SALT = 'nova-pg-2026';
const CUSTOM_IMAGE_SIZE_LIMITS = {
  multiple: 16,
  maxAspectRatio: 3,
  minPixels: 655360,
  maxPixels: 8294400,
};
const IS_DEV = process.env.NODE_ENV !== 'production';
const STATIC_DIR = path.join(__dirname, '..', 'frontend', 'out');
const IMAGE_DIR = process.env.NOVA_IMAGE_DIR || path.join(__dirname, 'nova-images');
// CDP 功能为启动级开关：默认关闭，显式置 true 时才提供 /api/nova/cdp/*。
const CDP_ENABLED = String(process.env.NOVA_CDP_ENABLED ?? 'false').toLowerCase() === 'true';
const CDP_DIR = process.env.NOVA_CDP_DIR || path.join(path.dirname(IMAGE_DIR), 'cdp-products');
const taskRefImages = new Map();

// CDP 图片自动清理：保留最近 7 天或最多 100 张，防止无限累积
function cleanupOldCdpImages() {
  try {
    if (!fs.existsSync(CDP_DIR)) return;
    const files = fs.readdirSync(CDP_DIR).filter(f => /\.(jpg|png|jpeg|webp|gif)$/i.test(f));
    if (files.length === 0) return;

    // 按修改时间排序（最新的在前）
    const fileStats = files.map(f => {
      const fullPath = path.join(CDP_DIR, f);
      const stat = fs.statSync(fullPath);
      return { name: f, path: fullPath, mtime: stat.mtime.getTime() };
    }).sort((a, b) => b.mtime - a.mtime);

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const toDelete = [];

    // 规则 1：超过 100 张，删除最旧的
    if (fileStats.length > 100) {
      toDelete.push(...fileStats.slice(100).map(f => f.path));
    }

    // 规则 2：超过 7 天的全部删除
    for (const f of fileStats) {
      if (f.mtime < sevenDaysAgo && !toDelete.includes(f.path)) {
        toDelete.push(f.path);
      }
    }

    if (toDelete.length > 0) {
      for (const p of toDelete) {
        try { fs.unlinkSync(p); } catch {}
      }
      console.log(`✓ CDP 图片清理：删除 ${toDelete.length} 张旧图（保留最近 7 天或最多 100 张）`);
    }
  } catch (err) {
    console.error('CDP 图片清理失败:', err.message);
  }
}

// 启动时清理一次，之后每小时清理一次
cleanupOldCdpImages();
setInterval(cleanupOldCdpImages, 60 * 60 * 1000);

const app = IS_DEV ? next({ dev: IS_DEV, hostname: HOSTNAME, port: PORT, dir: path.join(__dirname, '..', 'frontend') }) : null;
const handle = app ? app.getRequestHandler() : null;
const db = new Database(DB_PATH);
const apiKeys = new Map();
const taskSources = new Map(); // taskId -> { ip, apiKeyHash }
const rateLimitBuckets = new Map(); // key -> { windowStart: number, count: number }
const pendingCountByIp = new Map(); // ip -> count
const pendingCountByApiKeyHash = new Map(); // apiKeyHash -> count
const queue = [];
let activeCount = 0;

/**
 * 插件任务的上游实时进度与状态。这两个是过程量，不入库：服务器重启时所有未终态任务
 * 一律标失败（见 initDatabase），重启后没有需要恢复的进度。
 */
const pluginTaskProgress = new Map(); // taskId -> { progress?: number, upstreamStatus?: string }
const pluginTaskCache = new Map(); // taskId -> { lastPolledAt: number, cachedResponse: object, inFlightPromise: Promise|null }
const runningTaskPromises = new Set();
let isShuttingDown = false;
let shutdownPromise = null;
let httpServerRef = null;
let wsServerRef = null;

// ===== WebSocket subscription state =====
const taskSubscriptions = new Map(); // WebSocket -> Set<taskId>
const queueSubscribers = new Set(); // Set<WebSocket>
const wsAlive = new WeakMap(); // WebSocket -> { lastPong: number, missed: number }
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const WS_PONG_GRACE_MS = 10 * 1000;
// 单条 subscribeTasks 消息最多处理的 taskId 数，以及单连接订阅总量上限，
// 防止一条消息被放大成大量 DB 查询（DoS 面）。
const WS_MAX_TASK_IDS_PER_MESSAGE = 200;
const WS_MAX_SUBSCRIPTIONS_PER_SOCKET = 500;
let queueBroadcastTimer = null;
let queueBroadcastPending = false;

function getMaxServerConcurrency() {
  const configured = Number(getRuntimeEnv().NOVA_TASK_CONCURRENCY || GLOBAL_TASK_CONCURRENCY);
  const safeConfigured = Number.isFinite(configured) ? configured : GLOBAL_TASK_CONCURRENCY;
  return Math.max(1, Math.min(GLOBAL_TASK_CONCURRENCY, safeConfigured));
}

function parseIntegerEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function getLimitConfig() {
  const env = getRuntimeEnv();
  return {
    maxQueueSize: parseIntegerEnv(env.NOVA_MAX_QUEUE_SIZE, DEFAULT_LIMIT_CONFIG.maxQueueSize, { min: 0, max: 100000 }),
    rateLimitWindowMs: parseIntegerEnv(env.NOVA_RATE_LIMIT_WINDOW_MS, DEFAULT_LIMIT_CONFIG.rateLimitWindowMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    maxRequestsPerIp: parseIntegerEnv(env.NOVA_RATE_LIMIT_MAX_REQUESTS_PER_IP, DEFAULT_LIMIT_CONFIG.maxRequestsPerIp, { min: 0, max: 100000 }),
    maxRequestsPerApiKey: parseIntegerEnv(env.NOVA_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY, DEFAULT_LIMIT_CONFIG.maxRequestsPerApiKey, { min: 0, max: 100000 }),
    maxPendingTasksPerIp: parseIntegerEnv(env.NOVA_MAX_PENDING_TASKS_PER_IP, DEFAULT_LIMIT_CONFIG.maxPendingTasksPerIp, { min: 0, max: 100000 }),
    maxPendingTasksPerApiKey: parseIntegerEnv(env.NOVA_MAX_PENDING_TASKS_PER_API_KEY, DEFAULT_LIMIT_CONFIG.maxPendingTasksPerApiKey, { min: 0, max: 100000 }),
    retryAfterSeconds: parseIntegerEnv(env.NOVA_RATE_LIMIT_RETRY_AFTER_SECONDS, DEFAULT_LIMIT_CONFIG.retryAfterSeconds, { min: 1, max: 24 * 60 * 60 }),
  };
}

// ===== CDP（浏览器调试协议）配置 =====
// 与限流配置一样走 getRuntimeEnv() 热生效：改 .env 后约 1 秒内生效，无需重启。
const DEFAULT_CDP_CONFIG = {
  host: '127.0.0.1',
  port: 9222,
  timeoutMs: 20000,
};
let warnedNonLoopbackCdpHost = false;

function getCdpConfig() {
  const env = getRuntimeEnv();
  const runtime = readCdpRuntimeConfig();
  const configuredHost = String(env.NOVA_CDP_HOST || '').trim() || DEFAULT_CDP_CONFIG.host;
  const host = normalizeCdpHost(configuredHost);
  if (!warnedNonLoopbackCdpHost && configuredHost !== host) {
    warnedNonLoopbackCdpHost = true;
    console.warn(`[cdp] NOVA_CDP_HOST=${configuredHost} 非回环地址，已限制为 ${host}；不会扩大网络暴露。`);
  }
  return {
    host,
    // 优先级：运行时配置（设置页改端口）> 环境变量 > 默认 9222
    port: parseIntegerEnv(runtime.port ?? env.NOVA_CDP_PORT, DEFAULT_CDP_CONFIG.port, { min: 1, max: 65535 }),
    timeoutMs: parseIntegerEnv(env.NOVA_CDP_TIMEOUT_MS, DEFAULT_CDP_CONFIG.timeoutMs, { min: 1000, max: 120000 }),
    launchEnabled: String(env.NOVA_CDP_LAUNCH_ENABLED ?? 'true').toLowerCase() !== 'false',
    evalEnabled: String(env.NOVA_CDP_EVAL_ENABLED ?? 'false').toLowerCase() === 'true',
  };
}

// /api/nova/cdp/read-page 注入页面内的固定表达式：克隆 body → 移除 script/style/noscript
// → 取 innerText → 压缩连续空白 → 截断到 maxChars。maxChars 为已钳制的整数，直接内联。
const READ_PAGE_MAX_CHARS_DEFAULT = 8000;
const READ_PAGE_MAX_CHARS_LIMIT = 20000;

function buildReadPageExpression(maxChars) {
  return `(() => {
  const root = document.body ? document.body.cloneNode(true) : null;
  if (!root) return { title: document.title || '', url: location.href, text: '' };
  root.querySelectorAll('script, style, noscript').forEach(node => node.remove());
  const text = String(root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxChars});
  return { title: document.title || '', url: location.href, text };
})()`;
}

// CdpError.code → HTTP 状态码映射（多模块共享契约，勿擅自改动）
const CDP_ERROR_HTTP_STATUS = {
  CDP_TIMEOUT: 504,
  CDP_TARGET_NOT_FOUND: 404,
  CDP_PROTOCOL: 502,
  CDP_UNREACHABLE: 502,
};

const CDP_RUNTIME_CONFIG_PATH = path.join(path.dirname(CDP_DIR), 'cdp-config.json');
let cdpRuntimeConfigCache = null;
let cdpRuntimeConfigCacheTime = 0;
const CDP_CONFIG_CACHE_TTL_MS = 5000;
let launchInProgress = false;

function readCdpRuntimeConfig() {
  const now = Date.now();
  if (cdpRuntimeConfigCache && now - cdpRuntimeConfigCacheTime < CDP_CONFIG_CACHE_TTL_MS) {
    return cdpRuntimeConfigCache;
  }
  try {
    // 用户用记事本/PowerShell 手工编辑可能带入 UTF-8 BOM，先剥离再解析
    const parsed = JSON.parse(fs.readFileSync(CDP_RUNTIME_CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    const config = parsed && typeof parsed === 'object' ? parsed : {};
    cdpRuntimeConfigCache = config;
    cdpRuntimeConfigCacheTime = now;
    return config;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[cdp-config] 读取失败: ${error.message}`);
    }
    const empty = {};
    cdpRuntimeConfigCache = empty;
    cdpRuntimeConfigCacheTime = now;
    return empty;
  }
}

function writeCdpRuntimeConfig(next) {
  fs.mkdirSync(path.dirname(CDP_RUNTIME_CONFIG_PATH), { recursive: true });
  const tempPath = `${CDP_RUNTIME_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tempPath, CDP_RUNTIME_CONFIG_PATH);
  cdpRuntimeConfigCache = next;
  cdpRuntimeConfigCacheTime = Date.now();
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = require('net').createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

// CDP 路由统一错误出口：CdpError 按契约映射状态码，且保留原始中文错误。
// 不能走 sendHttpError → normalizeError，否则 "fetch failed" 会被改写成「网络连接失败」。
function sendCdpError(res, error) {
  if (isHttpError(error)) {
    sendHttpError(res, error);
    return;
  }
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (error instanceof CdpError || CDP_ERROR_HTTP_STATUS[code]) {
    const statusCode = CDP_ERROR_HTTP_STATUS[code] || 502;
    sendJson(res, statusCode, {
      error: error.message || '浏览器操作失败，请稍后重试。',
      code: code || 'CDP_PROTOCOL',
    });
    return;
  }
  sendJson(res, 400, { error: normalizeError(error) });
}

function createHttpError(statusCode, code, message, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryAfter = retryAfterSeconds;
  return error;
}

function isHttpError(error) {
  return error && typeof error.statusCode === 'number' && typeof error.code === 'string';
}

function parseIpv6Address(address) {
  const normalized = String(address || '').trim().toLowerCase().split('%', 1)[0];
  if (!normalized || (normalized.match(/::/g) || []).length > 1) return null;

  const [leftPart, rightPart] = normalized.includes('::')
    ? normalized.split('::')
    : [normalized, null];
  const parsePart = part => {
    if (!part) return [];
    const words = [];
    for (const token of part.split(':')) {
      if (!token) return null;
      if (token.includes('.')) {
        const octets = token.split('.').map(Number);
        if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      words.push(Number.parseInt(token, 16));
    }
    return words;
  };

  const left = parsePart(leftPart);
  const right = rightPart === null ? [] : parsePart(rightPart);
  if (!left || !right) return null;
  if (rightPart === null) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing > 0 ? [...left, ...Array(missing).fill(0), ...right] : null;
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim();
  if (net.isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return octets.length === 4 && octets[0] === 127;
  }
  if (net.isIP(normalized) !== 6) return false;

  const words = parseIpv6Address(normalized);
  if (!words) return false;
  if (words.every((word, index) => index < 7 ? word === 0 : word === 1)) return true;
  const isIpv4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  return isIpv4Mapped && (words[6] >> 8) === 127;
}

function headerHasValue(value) {
  if (Array.isArray(value)) return value.some((item) => String(item || '').trim());
  return Boolean(String(value || '').trim());
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').trim();
}

function tokensEqual(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authorizeCdpRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return {
      ok: false,
      status: 403,
      code: 'CDP_LOOPBACK_ONLY',
      error: '浏览器 CDP 接口仅允许本机回环访问。',
    };
  }
  if (headerHasValue(req.headers?.['x-forwarded-for'])) {
    const expected = String(getRuntimeEnv().NOVA_CDP_TOKEN || process.env.NOVA_CDP_TOKEN || '').trim();
    const provided = firstHeaderValue(req.headers?.['x-nova-cdp-token']);
    if (!tokensEqual(provided, expected)) {
      return {
        ok: false,
        status: 403,
        code: 'CDP_AUTH_REQUIRED',
        error: '经代理访问浏览器 CDP 接口需要有效令牌。',
      };
    }
  }
  return { ok: true };
}

function getClientIp(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = String(firstForwarded || '').split(',')[0].trim()
    || req?.socket?.remoteAddress
    || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 24);
}

/**
 * 插件参考素材的存储。上游的视频接口只接受 URL，所以素材先落盘本机，
 * 再把公网地址交给上游去拉；素材绑定任务后随任务一起清理。
 */
const pluginMedia = createMediaStore({
  db,
  getRuntimeEnv,
  parseIntegerEnv,
  createHttpError,
  getClientIp,
  normalizeBaseUrl,
});

function cleanupTaskRuntimeState(taskId) {
  const source = taskSources.get(taskId);
  if (source) {
    // 递减 IP 计数
    if (source.ip) {
      const ipCount = pendingCountByIp.get(source.ip) || 0;
      if (ipCount <= 1) {
        pendingCountByIp.delete(source.ip);
      } else {
        pendingCountByIp.set(source.ip, ipCount - 1);
      }
    }
    // 递减 apiKeyHash 计数
    if (source.apiKeyHash) {
      const hashCount = pendingCountByApiKeyHash.get(source.apiKeyHash) || 0;
      if (hashCount <= 1) {
        pendingCountByApiKeyHash.delete(source.apiKeyHash);
      } else {
        pendingCountByApiKeyHash.set(source.apiKeyHash, hashCount - 1);
      }
    }
  }
  apiKeys.delete(taskId);
  taskRefImages.delete(taskId);
  taskSources.delete(taskId);
  pluginTaskProgress.delete(taskId);
}

function getPendingCountForSource(fieldName, value) {
  if (!value) return 0;
  // O(1) 查找：使用独立计数器代替遍历 taskSources
  if (fieldName === 'ip') return pendingCountByIp.get(value) || 0;
  if (fieldName === 'apiKeyHash') return pendingCountByApiKeyHash.get(value) || 0;
  // fallback：未知字段仍用遍历（不应发生）
  let count = 0;
  for (const source of taskSources.values()) {
    if (source?.[fieldName] === value) count++;
  }
  return count;
}

function consumeRateLimit(bucketKey, maxRequests, windowMs) {
  if (maxRequests <= 0) {
    return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  const now = Date.now();
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= windowMs) {
    rateLimitBuckets.set(bucketKey, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - existing.windowStart)) / 1000)) };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function cleanupRateLimitBuckets() {
  const now = Date.now();
  const maxWindowMs = getLimitConfig().rateLimitWindowMs;
  for (const [key, bucket] of rateLimitBuckets) {
    if (!bucket || now - bucket.windowStart > maxWindowMs * 2) {
      rateLimitBuckets.delete(key);
    }
  }
}

function enforceRateLimit(req, body, config) {
  const ip = getClientIp(req);
  const apiKeyHash = hashApiKey(body.apiKey);
  const ipLimit = consumeRateLimit(`ip:${ip}`, config.maxRequestsPerIp, config.rateLimitWindowMs);
  if (!ipLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, ipLimit.retryAfterSeconds));
  }
  const apiKeyLimit = consumeRateLimit(`api:${apiKeyHash}`, config.maxRequestsPerApiKey, config.rateLimitWindowMs);
  if (!apiKeyLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, apiKeyLimit.retryAfterSeconds));
  }
  return { ip, apiKeyHash };
}

function enforceQueueCapacity(source, config) {
  const stats = getQueueStats();
  if (stats.pendingCount >= config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('ip', source.ip) >= config.maxPendingTasksPerIp) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('apiKeyHash', source.apiKeyHash) >= config.maxPendingTasksPerApiKey) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
}

function isRejectNewTasksEnabled() {
  const env = getRuntimeEnv();
  const rejectSwitch = String(env.NOVA_REJECT_NEW_TASKS || '').trim().toLowerCase();
  const acceptSwitch = String(env.NOVA_ACCEPT_NEW_TASKS || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(rejectSwitch) || acceptSwitch === 'false' || acceptSwitch === '0';
}

function getQueueStats() {
  const config = getLimitConfig();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    WHERE status IN (?, ?, ?)
    GROUP BY status
  `).all(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING);
  const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count || 0)]));
  const processingCount = counts[TASK_STATUS.PROCESSING] || 0;
  const queuedCount = (counts[TASK_STATUS.QUEUED] || 0) + (counts[TASK_STATUS.LEGACY_QUEUED] || 0);
  const totalActiveTasks = processingCount + queuedCount;
  const acceptingNewTasks = !isShuttingDown && !isRejectNewTasksEnabled();

  return {
    concurrencyLimit: GLOBAL_TASK_CONCURRENCY,
    configuredConcurrency: getMaxServerConcurrency(),
    processingCount,
    queuedCount,
    pendingCount: totalActiveTasks,
    maxQueueSize: config.maxQueueSize,
    remainingQueueSlots: Math.max(0, config.maxQueueSize - totalActiveTasks),
    displayConcurrency: Math.min(GLOBAL_TASK_CONCURRENCY, totalActiveTasks),
    displayQueued: Math.max(0, totalActiveTasks - GLOBAL_TASK_CONCURRENCY),
    acceptingNewTasks,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxRequestsPerIp: config.maxRequestsPerIp,
    rateLimitMaxRequestsPerApiKey: config.maxRequestsPerApiKey,
    retryAfterSeconds: config.retryAfterSeconds,
    serverMessage: acceptingNewTasks ? undefined : LIMIT_ERROR_MESSAGES.notAcceptingTasks,
  };
}

// ===== Image Storage Service =====

function ensureImageDir() {
  try {
    if (!fs.existsSync(IMAGE_DIR)) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
    }
    console.log(`[image-storage] 图片存储目录: ${IMAGE_DIR}`);
  } catch (error) {
    console.error(`[image-storage] 无法创建图片存储目录: ${IMAGE_DIR}`, error);
    process.exit(1);
  }
}

function ensureCdpDir() {
  try {
    if (!fs.existsSync(CDP_DIR)) {
      fs.mkdirSync(CDP_DIR, { recursive: true });
    }
    console.log(`[cdp] 商品素材存储目录: ${CDP_DIR}`);
  } catch (error) {
    console.error(`[cdp] 无法创建商品素材存储目录: ${CDP_DIR}`, error);
    process.exit(1);
  }
}

// 按常见安装位置查找本机 Chrome/Chromium；NOVA_CHROME_PATH 可显式覆盖。
function findChromeExecutable() {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else if (process.platform === 'win32') {
    const programDirs = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of programDirs) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const base of programDirs) {
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

function getCdpImageExtension(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

// 抓取的图片统一落盘到 CDP_DIR，文件名带 url 摘要便于排查，返回对外 localUrl。
function saveCdpImageToDisk(url, imageBuffer, mimeType) {
  const urlHash = createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  const fileName = `p_${urlHash}_${Date.now()}.${getCdpImageExtension(mimeType)}`;
  fs.writeFileSync(path.join(CDP_DIR, fileName), imageBuffer);
  return { fileName, localUrl: `/api/nova/cdp/products/${fileName}` };
}

// 同一图片 URL 已抓过就直接复用落盘文件：不再经浏览器下载，也不产生重复文件。
// 复用时触碰 mtime，避免「7 天未使用清理」误删仍被会话引用的图。
function findCdpImageByUrl(url) {
  const urlHash = createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
  try {
    const hit = fs.readdirSync(CDP_DIR).find(name => name.startsWith(`p_${urlHash}_`));
    if (!hit) return null;
    const filePath = path.join(CDP_DIR, hit);
    const now = new Date();
    fs.utimesSync(filePath, now, now);
    return { fileName: hit, localUrl: `/api/nova/cdp/products/${hit}` };
  } catch {
    return null;
  }
}

function resolveCdpProductFileName(input) {
  const raw = String(input || '').trim();
  const fileName = raw.replace(/^\/api\/nova\/cdp\/products\//, '').split(/[\\/]/).pop() || '';
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return null;
  if (!/^(p_[a-f0-9]{16}_\d+|shot_\d+)\.(jpg|jpeg|png|webp|gif)$/i.test(fileName)) return null;
  return fileName;
}

function purgeCdpProductFiles(files) {
  const names = [...new Set((Array.isArray(files) ? files : []).map(resolveCdpProductFileName).filter(Boolean))];
  let deleted = 0;
  const cdpDirResolved = path.resolve(CDP_DIR);
  for (const fileName of names) {
    const filePath = path.resolve(cdpDirResolved, fileName);
    if (!filePath.startsWith(cdpDirResolved + path.sep)) continue;
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch {}
  }
  return deleted;
}

function getImageExtension(mimeType) {
  if (mimeType?.includes('jpeg') || mimeType?.includes('jpg')) return 'jpg';
  if (mimeType?.includes('webp')) return 'webp';
  return 'png';
}

function saveImageToDisk(taskId, itemIndex, subIndex, imageBuffer, mimeType) {
  const ext = getImageExtension(mimeType);
  const fileName = `${taskId}-${itemIndex}-${subIndex}.${ext}`;
  const filePath = path.join(IMAGE_DIR, fileName);
  fs.writeFileSync(filePath, imageBuffer);
  return { filePath, httpUrl: `/api/nova/images/${taskId}/${itemIndex}` };
}

async function downloadUrlToDisk(taskId, itemIndex, subIndex, imageUrl) {
  const response = await fetchWithTimeout(imageUrl, {});
  if (!response.ok) throw new Error(`远程图片下载失败: ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/png';
  const buffer = Buffer.from(await response.arrayBuffer());
  return saveImageToDisk(taskId, itemIndex, subIndex, buffer, contentType);
}

function getTaskImageFiles(taskId) {
  try {
    if (!fs.existsSync(IMAGE_DIR)) return [];
    const prefix = `${taskId}-`;
    return fs.readdirSync(IMAGE_DIR)
      .filter(name => name.startsWith(prefix))
      .map(name => path.join(IMAGE_DIR, name));
  } catch {
    return [];
  }
}

function deleteImageFile(filePath, _taskId) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: true, reason: 'not_found' };
    }
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (error) {
    console.warn(`[image-lifecycle] 删除文件失败: ${filePath}`, error?.message || error);
    return { success: false, reason: error?.message || String(error) };
  }
}

function deleteTaskImageFiles(taskId) {
  const files = getTaskImageFiles(taskId);
  let successCount = 0;
  let notFoundCount = 0;
  let failedCount = 0;
  for (const filePath of files) {
    const result = deleteImageFile(filePath, taskId);
    if (result.success && result.reason === 'not_found') {
      notFoundCount++;
    } else if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }
  }
  console.log(`[image-lifecycle] 任务图片清理完成: taskId=${taskId}, total=${files.length}, success=${successCount}, notFound=${notFoundCount}, failed=${failedCount}`);
  return { total: files.length, success: successCount, notFound: notFoundCount, failed: failedCount };
}

function initDatabase() {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      warning TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_items (
      task_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      image_data TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (task_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_expires_at ON tasks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_items_task_id ON task_items(task_id);
  `);

  // 插件素材表（plugin_media）与任务表同库，任务清理即素材清理
  pluginMedia.initSchema();

  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  db.prepare('UPDATE task_items SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  const interruptedIds = db.prepare(`
    SELECT id FROM tasks WHERE status IN (?, ?)
  `).all(TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING).map(r => r.id);
  db.prepare(`
    UPDATE tasks
    SET status = 'failed', error = ?, completed_at = ?, expires_at = ?
    WHERE status IN (?, ?)
  `).run('服务器重启，任务已中断，请重新生成', now, new Date(Date.now() + TASK_TTL_MS).toISOString(), TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING);
  for (const id of interruptedIds) {
    deleteTaskImageFiles(id);
  }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendHttpError(res, error) {
  const headers = {};
  if (error.retryAfter) {
    headers['Retry-After'] = String(error.retryAfter);
  }
  // 413 时请求体可能仍在上传，保持 keep-alive 会让残留入站数据干扰下个请求；
  // 显式关闭连接，确保客户端能干净收到这条错误响应。
  if (error.statusCode === 413) {
    headers['Connection'] = 'close';
  }
  sendJson(res, error.statusCode, {
    error: normalizeError(error),
    code: error.code,
    retryAfter: error.retryAfter,
  }, headers);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

// 统一的文件流响应：必须挂 'error' 监听，否则流中途出错（文件被删 / EACCES /
// 磁盘错）会抛出未捕获异常拖垮整个进程。头已发出时只能断开连接。
function pipeFileToResponse(res, filePath, statusCode, headers) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', error => {
    console.warn(`[static] 文件流读取失败: ${filePath}`, error?.message || error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    } else {
      res.destroy(error);
    }
  });
  res.writeHead(statusCode, headers);
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname || '/');
  } catch {
    decodedPath = (pathname || '/').replace(/%(?![0-9a-fA-F]{2})/g, '');
  }
  // 路径遍历防护：规范化后检测 .. 路径段，提前拒绝
  const normalizedPath = path.normalize(decodedPath);
  if (normalizedPath.includes('..')) return false;

  const candidates = [];
  if (normalizedPath.endsWith('/') || normalizedPath.endsWith(path.sep)) {
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  } else {
    candidates.push(path.join(STATIC_DIR, normalizedPath));
    candidates.push(path.join(STATIC_DIR, `${normalizedPath}.html`));
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  }

  const staticDirResolved = path.resolve(STATIC_DIR) + path.sep;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(staticDirResolved) && resolved !== staticDirResolved.slice(0, -1)) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    pipeFileToResponse(res, resolved, 200, { 'Content-Type': getContentType(resolved) });
    return true;
  }

  const notFound = path.join(STATIC_DIR, '404.html');
  if (fs.existsSync(notFound)) {
    pipeFileToResponse(res, notFound, 404, { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  return false;
}

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10MB

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let aborted = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (aborted) return;
      raw += chunk;
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        aborted = true;
        raw = ''; // 释放已缓冲内存
        // 不再 req.destroy()：直接重置连接会让客户端收到 ERR_CONNECTION_RESET，
        // 看不到任何错误信息。改为排空剩余入站数据，并以 413 优雅返回（catch -> sendHttpError）。
        req.resume();
        reject(createHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大：参考图过多或分辨率过高，请减少参考图数量或降低分辨率后重试。'));
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求 JSON 格式无效'));
      }
    });
    req.on('error', reject);
  });
}

/** 图片编辑代理的请求体上限。image + mask 两张 PNG，按 4096² 上限留出余量。 */
const MAX_IMAGE_EDIT_BODY_BYTES = 64 * 1024 * 1024; // 64MB

/**
 * 读取原始请求体为 Buffer，不做任何解析。
 * 供 multipart 透传使用：解析再重组 multipart 既费内存也容易破坏 boundary。
 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        chunks.length = 0;
        req.resume(); // 排空剩余入站数据，避免客户端收到连接重置
        reject(createHttpError(
          413,
          'PAYLOAD_TOO_LARGE',
          `图片数据过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB），请缩小源图后重试。`,
        ));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed|network connection was lost|econnreset|socket hang up|terminated/i.test(message)) {
    return '网络连接失败。请检查服务器网络连接或稍后重试。';
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}秒）。高分辨率图片生成需要更长时间，请稍后重试。`;
  }
  // 截断非预定义错误消息，避免泄露内部信息（文件路径、堆栈等）
  return message.length > 200 ? message.slice(0, 200) + '…' : message;
}

function validateEnumValue(value, validValues, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!validValues.has(value)) {
    throw new Error(`${fieldName} 参数无效`);
  }
  return value;
}

function normalizeGptImageAdvancedParams(params = {}) {
  const quality = validateEnumValue(params.gptImageQuality, GPT_IMAGE_QUALITIES, 'quality');
  const style = validateEnumValue(params.gptImageStyle, GPT_IMAGE_STYLES, 'style');
  const background = validateEnumValue(params.gptImageBackground, GPT_IMAGE_BACKGROUNDS, 'background');

  return {
    quality: quality || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality,
    style: style || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style,
    background: background || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background,
  };
}

function validateCreatePayload(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不能为空');
  if (typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) throw new Error('缺少 API 密钥');
  if (typeof body.baseUrl !== 'string' || body.baseUrl.trim().length === 0) throw new Error('缺少 API 基础地址');
  if (!VALID_PROTOCOLS.has(body.protocol)) throw new Error(`协议类型无效，必须为 ${[...VALID_PROTOCOLS].join('、')}`);
  if (body.mode !== 'text-to-image' && body.mode !== 'image-to-image') throw new Error('任务模式无效');
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) throw new Error('提示词不能为空');
  if (typeof body.model !== 'string' || body.model.trim().length === 0) throw new Error('模型名称不能为空');
  if (!Number.isInteger(body.parallelCount) || body.parallelCount < 1 || body.parallelCount > 8) throw new Error('并发数量无效');

  if (!Array.isArray(body.images)) body.images = [];
  body.baseUrl = normalizeProtocolBaseUrl(body.protocol, body.baseUrl);
  if (!body.baseUrl) throw new Error('缺少 API 基础地址');
  // 开源版：不做模型级参数规范化，前端负责传递正确的参数，后端无条件透传
}

function createTask(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isShuttingDown || isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const source = enforceRateLimit(req, body, limitConfig);
  enforceQueueCapacity(source, limitConfig);

  const taskId = randomUUID();
  const now = new Date().toISOString();
  const requestForDb = {
    mode: body.mode,
    source: 'nova',
    protocol: body.protocol,
    baseUrl: body.baseUrl,
    prompt: body.prompt,
    outputSize: body.outputSize,
    customSize: body.customSize,
    aspectRatio: body.aspectRatio,
    temperature: body.temperature,
    model: body.model,
    gptImageQuality: body.gptImageQuality,
    gptImageStyle: body.gptImageStyle,
    gptImageBackground: body.gptImageBackground,
    parallelCount: body.parallelCount,
    images: body.images.map(img => ({ mimeType: img.mimeType })),
  };
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, status, mode, request_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, TASK_STATUS.QUEUED, body.mode, JSON.stringify(requestForDb), now);
    const insertItem = db.prepare(`
      INSERT INTO task_items (task_id, item_index, status, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < body.parallelCount; index++) {
      insertItem.run(taskId, index, TASK_STATUS.QUEUED, now);
    }
  });
  tx();

  apiKeys.set(taskId, body.apiKey);
  taskRefImages.set(taskId, body.images);
  taskSources.set(taskId, source);
  // 递增 pending 计数
  if (source.ip) pendingCountByIp.set(source.ip, (pendingCountByIp.get(source.ip) || 0) + 1);
  if (source.apiKeyHash) pendingCountByApiKeyHash.set(source.apiKeyHash, (pendingCountByApiKeyHash.get(source.apiKeyHash) || 0) + 1);
  queue.push(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainQueue();
  return taskId;
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function parseImageSize(size) {
  const match = String(size || '').match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
  if (!match) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function isImageSizeWithinLimits(width, height, maxSide) {
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

function getGptImageSize(outputSize, aspectRatio) {
  if (outputSize === 'auto' || outputSize === '512' || aspectRatio === 'auto') return undefined;
  const match = String(aspectRatio || '').match(/^(\d+):(\d+)$/);
  if (!match) return undefined;

  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
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

  if (outputSize !== '2K' && outputSize !== '4K') return undefined;
  const longSide = outputSize === '2K' ? 2048 : 3840;
  const width = ratioWidth > ratioHeight
    ? longSide
    : roundToMultiple(longSide * ratioWidth / ratioHeight, 16);
  const height = ratioWidth > ratioHeight
    ? roundToMultiple(longSide * ratioHeight / ratioWidth, 16)
    : longSide;
  return `${width}x${height}`;
}

function normalizeCustomImageSize(size, maxSide) {
  const parsed = parseImageSize(size);
  if (!parsed) return undefined;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const width = Math.min(roundToMultiple(parsed.width, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  const height = Math.min(roundToMultiple(parsed.height, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  if (!isImageSizeWithinLimits(width, height, maxSide)) return undefined;

  return `${width}x${height}`;
}

function getSupportedGptImageSize(model, outputSize, aspectRatio) {
  return getGptImageSize(outputSize, aspectRatio);
}

function resolveGptImageRequestSize(request) {
  const customSize = normalizeCustomImageSize(request.customSize, 4096);
  if (customSize) return customSize;
  return getSupportedGptImageSize(request.model, request.outputSize, request.aspectRatio);
}

function isAntigravityGeminiImageModel(model) {
  const id = String(model || '').toLowerCase();
  return id.includes('gemini') && id.includes('image');
}

function getAntigravityGeminiImageSize(outputSize) {
  const normalized = String(outputSize || '').trim().toUpperCase();
  if (normalized === '4K') return '4K';
  if (normalized === '2K') return '2K';
  return '1K';
}

function getAntigravityGeminiQuality(outputSize) {
  const imageSize = getAntigravityGeminiImageSize(outputSize);
  if (imageSize === '4K') return 'hd';
  if (imageSize === '2K') return 'medium';
  if (imageSize === '1K') return 'standard';
  return undefined;
}

function resolveOpenAiImageRequestSize(request) {
  if (isAntigravityGeminiImageModel(request.model)) {
    return resolveGeminiAspectRatio(request);
  }
  return resolveGptImageRequestSize(request);
}

function getGptImageRequestAdvancedParams(request) {
  return normalizeGptImageAdvancedParams(request);
}

function createGptImageRequestInit(apiKey, request, resolvedSize, options = {}) {
  const prompt = request.prompt;
  const antigravityGemini = isAntigravityGeminiImageModel(request.model);
  const advancedParams = antigravityGemini ? null : getGptImageRequestAdvancedParams(request);
  const stream = antigravityGemini ? false : Boolean(options.stream);
  const partialImages = antigravityGemini
    ? 0
    : Math.min(3, Math.max(0, Number(options.partialImages) || 0));
  const antigravityImageSize = antigravityGemini
    ? getAntigravityGeminiImageSize(request.outputSize)
    : undefined;
  const antigravityQuality = antigravityGemini
    ? getAntigravityGeminiQuality(request.outputSize)
    : undefined;

  if (request.mode === 'image-to-image') {
    // 实测结论（2026-08-30，birdsun 网关）：
    //   · OpenAI Images 网关（gpt-image-2）：只认 multipart/form-data 的 image 字段，
    //     多张参考图可多次 append 'image'（每张都生效，input_tokens 递增），
    //     JSON images[] 反而会 400（"images[].image_url is required"）。
    //   · antigravity Geminj 网关：认 image1/image2... 字段。
    //   · grok 网关：走 JSON images[{type,url}]（见 createGrokImageRequestInit）。
    // 因此这里按网关类型区分，绝不统一成 JSON images[]。
    if (antigravityGemini) {
      const formData = new FormData();
      formData.append('model', request.model);
      formData.append('prompt', prompt);
      formData.append('n', '1');
      if (resolvedSize) {
        formData.append('size', resolvedSize);
        formData.append('aspect_ratio', resolvedSize);
      }
      if (antigravityQuality) formData.append('quality', antigravityQuality);
      if (antigravityImageSize) {
        formData.append('image_size', antigravityImageSize);
        formData.append('imageSize', antigravityImageSize);
      }
      request.images.forEach((img, index) => {
        const mimeType = img.mimeType || 'image/png';
        const extension = mimeType.split('/')[1] || 'png';
        const bytes = Buffer.from(img.data, 'base64');
        const blob = new Blob([bytes], { type: mimeType });
        const filename = `image-${index}.${extension}`;
        // 第一张同时作为通用 image 字段（兼容只认 image 的网关）
        if (index === 0) formData.append('image', blob, filename);
        formData.append(`image${index + 1}`, blob, filename);
      });
      return {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
      };
    }

    // OpenAI Images（gpt-image-2）：form-data 多 image 字段保序。
    // 前端 prompt 里「图1/图2/图3」按 referencedImageIds 顺序在 request.images 中一一对应。
    const formData = new FormData();
    formData.append('model', request.model);
    formData.append('prompt', prompt);
    formData.append('n', '1');
    if (stream) {
      formData.append('stream', 'true');
      if (partialImages > 0) formData.append('partial_images', String(partialImages));
    }
    if (advancedParams) {
      formData.append('quality', advancedParams.quality);
      formData.append('background', advancedParams.background);
      formData.append('output_format', 'png');
      if (advancedParams.style === 'vivid' || advancedParams.style === 'natural') {
        formData.append('style', advancedParams.style);
      }
    }
    if (resolvedSize) formData.append('size', resolvedSize);
    request.images.forEach((img, index) => {
      const mimeType = img.mimeType || 'image/png';
      const extension = mimeType.split('/')[1] || 'png';
      const bytes = Buffer.from(img.data, 'base64');
      const blob = new Blob([bytes], { type: mimeType });
      const filename = `image-${index}.${extension}`;
      formData.append('image', blob, filename);
    });

    return {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    };
  }

  const payload = {
    prompt,
    model: request.model,
    ...(stream ? { stream: true, ...(partialImages > 0 ? { partial_images: partialImages } : {}) } : {}),
    ...(resolvedSize ? { size: resolvedSize } : {}),
    ...(advancedParams ? {
      quality: advancedParams.quality,
      background: advancedParams.background,
      output_format: 'png',
      ...(advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}),
    } : {}),
    ...(antigravityGemini ? {
      ...(resolvedSize ? { aspect_ratio: resolvedSize } : {}),
      ...(antigravityQuality ? { quality: antigravityQuality } : {}),
      ...(antigravityImageSize ? { imageSize: antigravityImageSize, image_size: antigravityImageSize } : {}),
      response_format: 'b64_json',
    } : {}),
    ...(request.images.length > 0 ? { image: request.images.map(img => `data:${img.mimeType};base64,${img.data}`) } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  };
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isLikelyHtmlResponse(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body');
}

function summarizeUnexpectedResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (isLikelyHtmlResponse(trimmed)) {
    return '上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。';
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function getMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
  }

  return '';
}

function getErrorMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.error) return getMessageFromPayload(payload);

  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
  if (type === 'error' || type === 'upstream_error') return getMessageFromPayload(payload);

  // DashScope 风格：顶层 {code, message}，没有 error 字段
  if (typeof payload.code === 'string' && payload.code.trim()) {
    return getMessageFromPayload(payload);
  }

  return '';
}

function getUpstreamErrorText(text, status) {
  const trimmed = String(text || '').trim();
  const data = parseJsonSafely(trimmed);
  const message = getErrorMessageFromPayload(data) || getMessageFromPayload(data);
  if (message) return message;

  const lower = trimmed.toLowerCase();
  const looksLikeGatewayHtml = isLikelyHtmlResponse(trimmed) && (
    Number(status) === 504 ||
    Number(status) === 502 ||
    Number(status) === 503 ||
    lower.includes('gateway time-out') ||
    lower.includes('gateway timeout') ||
    lower.includes('openresty')
  );
  if (looksLikeGatewayHtml) {
    return '上游网关超时。这是 endpoint 反向代理超时，不是本地请求超时；请更换 endpoint 或稍后重试。';
  }

  if (isLikelyHtmlResponse(trimmed)) {
    return '上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。';
  }

  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function normalizeImagePayloadValue(imageData) {
  if (!imageData || typeof imageData !== 'string') return undefined;
  if (imageData.startsWith('data:image')) return imageData.split(',')[1] || imageData;
  if (/^https?:\/\//i.test(imageData)) return `URL:${imageData}`;
  return imageData;
}

function getImagePayloadValue(data, depth = 0) {
  if (!data || depth > 3) return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const value = getImagePayloadValue(item, depth + 1);
      if (value) return value;
    }
    return undefined;
  }
  if (typeof data !== 'object') return undefined;

  const firstImage = Array.isArray(data.data)
    ? data.data.find(item => item && typeof item === 'object' && (item.b64_json || item.url || item.image_url))
    : undefined;
  const imageData = firstImage?.b64_json || firstImage?.url || firstImage?.image_url
    || data.b64_json || data.url || data.image_url;
  if (imageData) return imageData;

  return getImagePayloadValue(data.result, depth + 1)
    || getImagePayloadValue(data.response, depth + 1)
    || getImagePayloadValue(data.output, depth + 1);
}

function extractImagePayload(data) {
  const imageData = normalizeImagePayloadValue(getImagePayloadValue(data));
  if (!imageData) throw new Error('响应中无图片数据');
  return imageData;
}

function parseImageEventStream(text) {
  const payloads = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    const parsed = parseJsonSafely(raw);
    if (parsed) payloads.push(parsed);
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  return payloads;
}

function isPartialImageEvent(payload) {
  const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
  return type.includes('partial');
}

function extractImagePayloadFromEventStream(text) {
  const payloads = parseImageEventStream(text);
  const errorMessage = payloads.map(getErrorMessageFromPayload).find(Boolean);

  for (const payload of [...payloads].reverse()) {
    if (isPartialImageEvent(payload)) continue;
    try {
      return extractImagePayload(payload);
    } catch {
      // Keep scanning earlier events.
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  throw new Error('响应中无图片数据');
}

async function parseGptImageResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const responseText = await response.text();

  if (!response.ok) {
    const errorText = getUpstreamErrorText(responseText, response.status);
    throw new Error(`API 请求失败: ${response.status}${errorText ? ` ${errorText}` : ''}`);
  }

  if (contentType.includes('text/event-stream')) {
    return extractImagePayloadFromEventStream(responseText);
  }

  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }

  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }

  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) throw new Error(errorMessage);

  return extractImagePayload(data);
}

function isImageStreamUnsupportedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return IMAGE_STREAM_UNSUPPORTED_PATTERN.test(message);
}

async function requestGptImage(apiKey, request, resolvedSize, options = {}) {
  const baseUrl = options.baseUrl || resolveNovaApiBaseUrl();
  const endpoint = request.mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
  const response = await fetchWithTimeout(
    `${baseUrl}${endpoint}`,
    createGptImageRequestInit(apiKey, request, resolvedSize, options)
  );
  return parseGptImageResponse(response);
}

function getGrokResolution(outputSize) {
  if (outputSize === '2K' || outputSize === '2k') return '2k';
  if (outputSize === '1K' || outputSize === '1k') return '1k';
  return undefined;
}

function getGrokAspectRatio(aspectRatio) {
  if (!aspectRatio || aspectRatio === 'auto') return undefined;
  return String(aspectRatio);
}

function toGrokImageDataUrl(img) {
  if (!img || typeof img !== 'object') return '';
  if (typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:')) return img.dataUrl;
  const mimeType = img.mimeType || 'image/png';
  const data = typeof img.data === 'string' ? img.data : '';
  if (!data) return '';
  if (data.startsWith('data:')) return data;
  return `data:${mimeType};base64,${data}`;
}

function createGrokImageRequestInit(apiKey, request, options = {}) {
  const prompt = request.prompt;
  const stream = Boolean(options.stream);
  const aspectRatio = getGrokAspectRatio(request.aspectRatio);
  const resolution = getGrokResolution(request.outputSize);
  const images = Array.isArray(request.images) ? request.images : [];

  if (request.mode === 'image-to-image') {
    if (images.length === 0) {
      throw new Error('图生图模式需要至少一张参考图');
    }
    const dataUrls = images.map(toGrokImageDataUrl).filter(Boolean);
    if (dataUrls.length === 0) {
      throw new Error('参考图数据无效');
    }
    if (dataUrls.length > 3) {
      throw new Error('Grok 图生图最多支持 3 张参考图');
    }
    const payload = {
      model: request.model,
      prompt,
      response_format: 'url',
      ...(stream ? { stream: true } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
      images: dataUrls.map(url => ({ type: 'image_url', url })),
    };
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    };
  }

  const payload = {
    model: request.model,
    prompt,
    response_format: 'url',
    ...(stream ? { stream: true } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  };
}

async function requestGrokImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveNovaApiBaseUrl();
  const endpoint = request.mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
  const response = await fetchWithTimeout(
    `${baseUrl}${endpoint}`,
    createGrokImageRequestInit(apiKey, request, options)
  );
  return parseGptImageResponse(response);
}

// 豆包 Seedream（ark）：文生图/图生图统一走 /v3/images/generations，
// 参考图以 image 参数（data URL 数组）传入，响应按 b64_json 解析。
async function requestDoubaoImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_ARK_BASE_URL;
  const url = buildDoubaoImagesUrl(baseUrl);
  const size = resolveDoubaoImageSize(request, req => resolveGptImageRequestSize(req));
  const payload = buildDoubaoImagePayload(request, size);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  return parseGptImageResponse(response);
}

// 阿里云百炼 Token Plan（DashScope multimodal-generation）：
// 请求体是 { model, input: { messages: [{ role, content: [{text}, {image}] }] }, parameters: { size } }
// 响应在 output.choices[0].message.content[0].image（URL 字符串）
async function requestAlibabaDashScopeImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_DASHSCOPE_BASE_URL;
  const url = buildDashScopeImageUrl(baseUrl);
  const size = resolveGptImageRequestSize(request);
  const payload = buildDashScopeImagePayload(request, size);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(getErrorMessageFromPayload(parseJsonSafely(text)) || `HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  // 与 openai/google 路径一致：网关拦截或 baseUrl 配错时上游常返回 HTML 错误页，
  // 直接 response.json() 会抛出难懂的解析错误，先做显式判断。
  const responseText = await response.text();
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }
  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) throw new Error(errorMessage);
  const imageUrl = extractDashScopeImageUrl(data);
  if (!imageUrl) throw new Error('响应中无图片 URL');
  // 下游约定：http(s) URL 必须带 URL: 前缀，否则会被当成 base64 落盘成乱码
  return `URL:${imageUrl}`;
}

// ===== 加强网络连接：启用 TCP keepalive，防止 Docker 回环连接被静默断开 =====
// Node.js 内置 fetch 基于 undici，默认不发送 TCP keepalive，
// 导致长时间等待响应（如 4K 图片生成）时连接被 Docker 网络层丢弃。
// 通过 setGlobalDispatcher 配置 undici Agent 的 keepalive 和超时参数。
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 60 * 1000,         // 空闲连接保持 60 秒
    keepAliveMaxTimeout: 10 * 60 * 1000, // 最大保持 10 分钟
    connect: {
      keepAlive: true,
      keepAliveInitialDelay: 15000,      // 15 秒后开始发送 TCP keepalive 探测
    },
    bodyTimeout: REQUEST_TIMEOUT_MS,     // 等待响应体的超时（与 abort 超时一致）
    headersTimeout: REQUEST_TIMEOUT_MS,  // 图片生成可能长时间等待响应头，需与任务超时一致
  }));
  console.log('[network] undici Agent 已配置: TCP keepalive=15s, timeout=30min');
} catch (e) {
  console.warn('[network] undici Agent 配置失败，使用默认设置:', e?.message || e);
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function generateNovaImage(apiKey, request) {
  // 开源版：根据前端传入的 protocol 字段路由到对应的 API 协议
  const baseUrl = request.baseUrl || resolveNovaApiBaseUrl();
  if (request.protocol === 'openai') {
    const resolvedSize = resolveOpenAiImageRequestSize(request);
    const antigravityGemini = isAntigravityGeminiImageModel(request.model);
    if (!IMAGE_STREAM_ENABLED || antigravityGemini) {
      return requestGptImage(apiKey, request, resolvedSize, { baseUrl });
    }
    try {
      return await requestGptImage(apiKey, request, resolvedSize, {
        baseUrl,
        stream: true,
        partialImages: IMAGE_STREAM_PARTIAL_IMAGES,
      });
    } catch (error) {
      if (!isImageStreamUnsupportedError(error)) throw error;
      console.warn('[image-stream] 上游不支持图片流式参数，回退非流式请求');
      return requestGptImage(apiKey, request, resolvedSize, { baseUrl });
    }
  }
  if (request.protocol === 'grok') {
    return requestGrokImage(apiKey, request, { baseUrl });
  }
  if (request.protocol === 'doubao') {
    return requestDoubaoImage(apiKey, request, { baseUrl });
  }
  if (request.protocol === 'alibaba-dashscope') {
    return requestAlibabaDashScopeImage(apiKey, request, { baseUrl });
  }
  // 默认走 Google Gemini 协议
  return generateNovaGeminiImage(apiKey, request, { baseUrl });
}

function extractGeminiImagePayload(data) {
  const imagePart = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data || part?.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) {
    const reasons = [
      data?.promptFeedback?.blockReason,
      data?.candidates?.[0]?.finishReason,
    ].filter(reason => typeof reason === 'string' && reason.trim());
    throw new Error(reasons.length ? `响应中无图片数据 (${reasons.join(', ')})` : '响应中无图片数据');
  }
  return inlineData.data;
}

const GEMINI_NATIVE_IMAGE_SIZES = new Set(['1K', '2K', '4K']);
const GEMINI_NATIVE_ASPECT_RATIOS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  '1:4', '1:8', '4:1', '8:1',
]);

function inferAspectRatioFromPrompt(prompt) {
  const text = String(prompt || '');
  const match = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (match) {
    const ratio = `${Number(match[1])}:${Number(match[2])}`;
    if (GEMINI_NATIVE_ASPECT_RATIOS.has(ratio)) return ratio;
  }
  if (/淘宝主图|天猫主图/.test(text)) return '3:4';
  return undefined;
}

function resolveGeminiAspectRatio(request = {}) {
  const rawRatio = String(request.aspectRatio || '').trim();
  if (GEMINI_NATIVE_ASPECT_RATIOS.has(rawRatio)) return rawRatio;
  return inferAspectRatioFromPrompt(request.prompt) || '1:1';
}

function resolveGeminiImageConfig(request = {}) {
  const rawSize = String(request.outputSize || '').trim().toUpperCase();
  return {
    imageSize: GEMINI_NATIVE_IMAGE_SIZES.has(rawSize) ? rawSize : '1K',
    aspectRatio: resolveGeminiAspectRatio(request),
  };
}

async function generateNovaGeminiImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveNovaApiBaseUrl();
  const images = Array.isArray(request.images) ? request.images : [];
  const parts = [
    { text: request.prompt },
    ...images.map(img => ({ inlineData: { data: img.data, mimeType: img.mimeType || 'image/png' } })),
  ];
  const imageConfig = resolveGeminiImageConfig(request);
  const response = await fetchWithTimeout(`${baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: request.temperature,
        responseModalities: ['IMAGE'],
        imageConfig,
      },
    }),
  });

  if (!response.ok) {
    const errorText = getUpstreamErrorText(await response.text(), response.status);
    throw new Error(`API 请求失败: ${response.status}${errorText ? ` ${errorText}` : ''}`);
  }

  const responseText = await response.text();
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }
  return extractGeminiImagePayload(data);
}

function drainQueue() {
  const maxConcurrency = getMaxServerConcurrency();
  while (queue.length > 0) {
    const taskId = queue[0];
    const task = db.prepare('SELECT mode, request_json FROM tasks WHERE id = ?').get(taskId);
    const req = task ? JSON.parse(task.request_json) : null;
    const isPluginTask = task?.mode === 'plugin';
    // 插件任务每个占 1 个名额，且名额从「开始跑」一直持有到「轮询出终态」，
    // 避免几十个视频任务同时压在上游。
    const imageSlots = isPluginTask ? 1 : (req?.parallelCount || 1);

    // 容量足够 → 放行。容量不足时唯一例外：当前空闲（activeCount===0）且该任务
    // 自身就超过总并发，允许其独占运行（否则永远无法被调度）；其余情况一律等待
    // 在飞任务腾出名额。
    const fitsWithinLimit = activeCount + imageSlots <= maxConcurrency;
    const oversizedTaskCanRunAlone = activeCount === 0 && imageSlots > maxConcurrency;
    if (!fitsWithinLimit && !oversizedTaskCanRunAlone) break;

    queue.shift();
    activeCount += imageSlots;
    const runPromise = (isPluginTask ? runPluginTask(taskId) : runTask(taskId)).finally(() => {
      activeCount -= imageSlots;
      runningTaskPromises.delete(runPromise);
      drainQueue();
    });
    runningTaskPromises.add(runPromise);
  }
}

async function generateSingleImage(apiKey, request, taskId, index) {
  try {
    const image = await generateNovaImage(apiKey, request);
    const expanded = image.startsWith('MULTI_URL:') ? image.substring(10).split('|||').map(url => `URL:${url}`) : [image];
    const diskRefs = [];
    for (let subIdx = 0; subIdx < expanded.length; subIdx++) {
      const img = expanded[subIdx];
      if (img.startsWith('URL:')) {
        const remoteUrl = img.substring(4);
        const result = await downloadUrlToDisk(taskId, index, subIdx, remoteUrl);
        diskRefs.push(`URL:${result.httpUrl}`);
      } else {
        const buffer = Buffer.from(img, 'base64');
        const result = saveImageToDisk(taskId, index, subIdx, buffer, 'image/png');
        diskRefs.push(`URL:${result.httpUrl}`);
      }
    }
    db.prepare("UPDATE task_items SET status = 'completed', image_data = ?, completed_at = ? WHERE task_id = ? AND item_index = ?")
      .run(JSON.stringify(diskRefs), new Date().toISOString(), taskId, index);
    return { success: true, images: diskRefs };
  } catch (error) {
    const message = normalizeError(error);
    db.prepare("UPDATE task_items SET status = 'failed', error = ?, completed_at = ? WHERE task_id = ? AND item_index = ?")
      .run(message, new Date().toISOString(), taskId, index);
    return { success: false, error: message };
  }
}

async function runTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const apiKey = apiKeys.get(taskId);
  if (!task || !apiKey || ![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
    cleanupTaskRuntimeState(taskId);
    return;
  }

  try {
    await runTaskBody(taskId, task, apiKey);
  } catch (error) {
    // 任何未预期异常（请求体损坏、字段缺失等）都必须落终态并释放内存，
    // 否则任务会永久卡在 processing、taskRefImages/apiKeys 永驻（重启才能自愈）。
    const message = normalizeError(error);
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(`任务执行异常: ${message}`, completedAt, expiresAt, taskId);
    cleanupTaskRuntimeState(taskId);
    broadcastTask(taskId);
    broadcastQueueStatus();
  }
}

async function runTaskBody(taskId, task, apiKey) {
  const request = JSON.parse(task.request_json);
  const refImages = taskRefImages.get(taskId);
  if (refImages && refImages.length > 0) {
    request.images = refImages;
  }
  db.prepare("UPDATE tasks SET status = 'processing' WHERE id = ?").run(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();

  // 所有图片标记为 processing
  for (let index = 0; index < request.parallelCount; index++) {
    db.prepare("UPDATE task_items SET status = 'processing', created_at = ? WHERE task_id = ? AND item_index = ?")
      .run(new Date().toISOString(), taskId, index);
  }

  // 真正并发生成所有图片
  const itemResults = await Promise.allSettled(
    Array.from({ length: request.parallelCount }, (_, index) =>
      generateSingleImage(apiKey, request, taskId, index)
    )
  );

  // 汇总结果
  const images = [];
  const errors = [];
  for (const result of itemResults) {
    if (result.status === 'fulfilled' && result.value.success) {
      images.push(...result.value.images);
    } else {
      const msg = result.status === 'fulfilled'
        ? result.value.error
        : normalizeError(result.reason);
      errors.push(msg);
    }
  }

  const completedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
  if (images.length > 0) {
    const warning = errors.length > 0 ? `${errors.length} 张图片生成失败: ${errors.join('; ')}` : null;
    db.prepare(`
      UPDATE tasks SET status = 'completed', result_json = ?, warning = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(JSON.stringify({ images }), warning, completedAt, expiresAt, taskId);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(`所有图片生成失败: ${errors.join('; ')}`, completedAt, expiresAt, taskId);
  }
  cleanupTaskRuntimeState(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
}

// ===== 插件任务 =====
//
// 这一段刻意不认识任何具体上游：模型清单、请求体、状态词表、结果路径全部来自
// backend/plugins/<id>/ 下的 JSON。这里只做「落库 → 排队 → 创建上游任务 →
// 轮询到终态 → 归一化产物」的生命周期，以及失败后的清理。

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 创建插件任务。以 queued 落库后进队列，由 drainQueue 按并发名额调度；
 * 上游创建挪到 runPluginTask 里，这样名额从「开始跑」一直持有到「轮询出终态」。
 */
function createPluginTask(body, req) {
  if (!body || typeof body !== 'object') throw new Error('请求体不能为空');
  if (typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) throw new Error('缺少 API 密钥');

  const plugin = pluginRegistry.getPlugin(body.pluginId);
  if (!plugin) {
    throw createHttpError(404, 'PLUGIN_NOT_FOUND', `插件 ${body.pluginId || ''} 未安装或加载失败`);
  }

  // 权威校验：前端也做同一套判断，但那只是为了即时反馈
  let normalized;
  try {
    normalized = validateAndNormalizeInput(plugin, body);
  } catch (error) {
    if (error instanceof InputError) {
      throw createHttpError(400, 'PLUGIN_INPUT_INVALID', error.message);
    }
    throw error;
  }

  const baseUrl = normalizeBaseUrl(body.baseUrl) || plugin.manifest.credential.defaultBaseUrl || '';
  if (!baseUrl) {
    throw new Error('缺少 API 基地址，请在设置中填写');
  }
  // 出网闸门在这里先跑一次：让「主机没申报」在提交那一刻就报错，而不是排到队首才失败
  pluginExecutor.assertUrlAllowed(plugin, `${baseUrl}/`, 'API 基地址');

  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const source = enforceRateLimit(req, body, limitConfig);
  enforceQueueCapacity(source, limitConfig);

  const taskId = randomUUID();
  const now = new Date().toISOString();
  const requestForDb = {
    mode: 'plugin',
    pluginId: plugin.id,
    pluginVersion: plugin.manifest.version,
    model: normalized.model,
    facets: normalized.facets,
    fields: normalized.fields,
    media: normalized.media,
    baseUrl,
  };

  db.prepare(`
    INSERT INTO tasks (id, status, mode, request_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    TASK_STATUS.QUEUED,
    'plugin',
    JSON.stringify(requestForDb),
    now,
    new Date(Date.now() + TASK_TTL_MS).toISOString(),
  );

  // 素材绑定到任务：此后随任务一起清理，也不再参与去重复用
  pluginMedia.bindToTask(taskId, normalized.mediaUrls);

  // apiKey 只留在内存里，从不入库
  apiKeys.set(taskId, body.apiKey);
  taskSources.set(taskId, source);
  if (source.ip) pendingCountByIp.set(source.ip, (pendingCountByIp.get(source.ip) || 0) + 1);
  if (source.apiKeyHash) pendingCountByApiKeyHash.set(source.apiKeyHash, (pendingCountByApiKeyHash.get(source.apiKeyHash) || 0) + 1);

  queue.push(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainQueue();

  return taskId;
}

/** 把插件任务标为失败，并立刻释放素材与图片占用的磁盘——失败任务没有任何产出值得保留。 */
function failPluginTask(taskId, message) {
  const completedAt = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ?
  `).run(message, completedAt, new Date(Date.now() + TASK_TTL_MS).toISOString(), taskId);
  pluginTaskCache.delete(taskId);
  deleteTaskImageFiles(taskId);
  pluginMedia.deleteTaskMedia(taskId);
  cleanupTaskRuntimeState(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
}

/** 缓存一份序列化结果，供前端 GET 在两次后端轮询之间直接命中。 */
function cachePluginTaskResponse(taskId) {
  const serialized = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  pluginTaskCache.set(taskId, {
    lastPolledAt: Date.now(),
    cachedResponse: serialized,
    inFlightPromise: null,
  });
  return serialized;
}

/**
 * 向上游查一次状态并把终态写回库。返回归一化后的状态。
 * 后端轮询循环与前端 GET 共用这一份逻辑，避免两处解析上游响应。
 */
async function pollPluginTaskOnce(taskId, plugin, context) {
  const outcome = await pluginExecutor.pollTask(plugin, context);

  // 请求本身失败时 pollTask 会回 processing 且不带 progress，这时保持上一次成功读数——
  // 那是几秒前的真实值，比因为一次抖动就把进度条打回未知要好。
  if (outcome.state !== 'processing' || outcome.progress !== undefined) {
    pluginTaskProgress.set(taskId, {
      progress: outcome.progress,
      upstreamStatus: outcome.state,
    });
  }

  if (outcome.state === 'completed') {
    const completedAt = new Date().toISOString();
    db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, completed_at = ?, expires_at = ? WHERE id = ?")
      .run(
        JSON.stringify({ assets: outcome.assets }),
        completedAt,
        new Date(Date.now() + TASK_TTL_MS).toISOString(),
        taskId,
      );
    cachePluginTaskResponse(taskId);
    broadcastTask(taskId);
    return 'completed';
  }

  if (outcome.state === 'failed') {
    failPluginTask(taskId, outcome.error || '生成失败');
    return 'failed';
  }

  cachePluginTaskResponse(taskId);
  return outcome.state;
}

/**
 * 插件任务的执行体：创建上游任务 → 轮询到终态。
 * 超过 provider 申报的上限就认失败，避免上游卡死永久占着并发名额。
 */
async function runPluginTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const apiKey = apiKeys.get(taskId);
  if (!task || !apiKey || ![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
    cleanupTaskRuntimeState(taskId);
    return;
  }

  const request = JSON.parse(task.request_json);
  const plugin = pluginRegistry.getPlugin(request.pluginId);
  if (!plugin) {
    failPluginTask(taskId, `插件 ${request.pluginId} 已被移除，任务无法继续`);
    return;
  }

  db.prepare("UPDATE tasks SET status = 'processing' WHERE id = ?").run(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();

  const baseContext = {
    plugin,
    baseUrl: request.baseUrl,
    apiKey,
    model: request.model,
    facets: request.facets,
    fields: request.fields,
    media: request.media,
  };

  let upstreamTaskId;
  try {
    const submitted = await pluginExecutor.submitTask(plugin, pluginExecutor.buildContext(baseContext));
    upstreamTaskId = submitted.upstreamTaskId;

    // 记下上游 ID：前端 GET 与后续轮询都要用
    db.prepare('UPDATE tasks SET request_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...request, upstreamTaskId }), taskId);

    // 少数上游在创建那一刻就直接返回成品，省掉一整轮轮询
    if (submitted.immediate) {
      const completedAt = new Date().toISOString();
      db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, completed_at = ?, expires_at = ? WHERE id = ?")
        .run(
          JSON.stringify({ assets: submitted.immediate.assets }),
          completedAt,
          new Date(Date.now() + TASK_TTL_MS).toISOString(),
          taskId,
        );
      pluginTaskProgress.set(taskId, { progress: 100, upstreamStatus: 'completed' });
      cachePluginTaskResponse(taskId);
      cleanupTaskRuntimeState(taskId);
      broadcastTask(taskId);
      broadcastQueueStatus();
      return;
    }
  } catch (error) {
    failPluginTask(taskId, normalizePluginError(error));
    return;
  }

  const { intervalMs, maxTotalMs } = pluginExecutor.resolvePollTiming(plugin);
  const deadline = Date.now() + maxTotalMs;
  const pollContext = pluginExecutor.buildContext({ ...baseContext, upstreamTaskId });

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    // 任务被删除 / 过期就别再轮询了
    const stillThere = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    if (!stillThere) {
      pluginTaskCache.delete(taskId);
      cleanupTaskRuntimeState(taskId);
      return;
    }
    if (stillThere.status === 'completed' || stillThere.status === 'failed') {
      cleanupTaskRuntimeState(taskId);
      return;
    }

    try {
      const state = await pollPluginTaskOnce(taskId, plugin, pollContext);
      if (state === 'completed' || state === 'failed') {
        cleanupTaskRuntimeState(taskId);
        broadcastQueueStatus();
        return;
      }
    } catch (error) {
      // 单次轮询失败不判死刑，等下一轮；上游抖动很常见
      console.warn(`[plugin-task] 轮询失败 taskId=${taskId}:`, error?.message || error);
    }
  }

  failPluginTask(taskId, `生成超时（超过 ${Math.round(maxTotalMs / 60000)} 分钟仍未完成），请重试`);
}

/**
 * 插件任务的错误归一化。不能直接用 normalizeError——它的超时分支写的是
 * 「高分辨率图片生成需要更长时间」，套到视频任务上会给出误导性的提示。
 */
function normalizePluginError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed|econnreset|socket hang up|terminated/i.test(message)) {
    return '连接上游失败，请检查服务器网络连接后重试。';
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return '上游创建任务超时，请稍后重试。';
  }
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * 前端 GET 用。状态推进由 runPluginTask 的后端轮询负责，这里只读库/缓存；
 * 仅当任务已在跑但后端轮询还没写回时，才顺带补一次上游查询。
 */
async function getPluginTaskForClient(taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!row) {
    return { id: taskId, status: 'expired', error: '该任务已超出取回时间' };
  }
  if (row.status === 'completed' || row.status === 'failed') {
    return serializeTask(row);
  }

  const request = parseJsonSafely(row.request_json) || {};
  // 还没拿到上游 ID 说明仍在本地队列里排队，直接回当前状态
  if (!request.upstreamTaskId) return serializeTask(row);

  const plugin = pluginRegistry.getPlugin(request.pluginId);
  const apiKey = apiKeys.get(taskId);
  if (!plugin || !apiKey) return serializeTask(row);

  const now = Date.now();
  const cached = pluginTaskCache.get(taskId);
  if (cached) {
    if (cached.inFlightPromise) return cached.inFlightPromise;
    if (now - cached.lastPolledAt < 5000 && cached.cachedResponse) return cached.cachedResponse;
  }

  const context = pluginExecutor.buildContext({
    plugin,
    baseUrl: request.baseUrl,
    apiKey,
    model: request.model,
    facets: request.facets,
    fields: request.fields,
    media: request.media,
    upstreamTaskId: request.upstreamTaskId,
  });

  const inFlightPromise = (async () => {
    try {
      await pollPluginTaskOnce(taskId, plugin, context);
    } catch (error) {
      console.warn(`[plugin-task] 前端触发的轮询失败 taskId=${taskId}:`, error?.message || error);
    } finally {
      const entry = pluginTaskCache.get(taskId);
      if (entry) entry.inFlightPromise = null;
    }
    return serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  })();

  if (cached) {
    cached.inFlightPromise = inFlightPromise;
  } else {
    pluginTaskCache.set(taskId, {
      lastPolledAt: now,
      cachedResponse: serializeTask(row),
      inFlightPromise,
    });
  }
  return inFlightPromise;
}

function serializeTask(task) {
  if (!task) return null;
  if (task.expires_at && Date.parse(task.expires_at) <= Date.now()) {
    return { id: task.id, status: 'expired', error: '该任务已超出取回时间' };
  }
  const result = task.result_json ? JSON.parse(task.result_json) : undefined;
  // 插件任务附带上游实时进度。status 仍是本机队列状态（排队中 = 等本机并发名额），
  // upstreamStatus 才是上游那边的状态，两者不是一回事，都要给前端。
  const live = task.mode === 'plugin' ? pluginTaskProgress.get(task.id) : undefined;
  const pluginMeta = task.mode === 'plugin' ? readPluginTaskMeta(task) : undefined;
  return {
    id: task.id,
    status: task.status,
    mode: task.mode,
    result,
    error: task.error,
    warning: task.warning,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    expiresAt: task.expires_at,
    ...(pluginMeta || {}),
    ...(typeof live?.progress === 'number' ? { progress: live.progress } : {}),
    ...(live?.upstreamStatus ? { upstreamStatus: live.upstreamStatus } : {}),
  };
}

/** 从 request_json 里取出可以安全下发的插件元信息（不含 apiKey——它从不入库）。 */
function readPluginTaskMeta(task) {
  const request = parseJsonSafely(task.request_json);
  if (!request) return {};
  return {
    pluginId: request.pluginId,
    pluginVersion: request.pluginVersion,
    model: request.model,
  };
}

function deleteTask(taskId) {
  deleteTaskImageFiles(taskId);
  // 素材与任务绑定：任务清理即素材清理
  pluginMedia.deleteTaskMedia(taskId);
  pluginTaskCache.delete(taskId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM task_items WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  tx();
  cleanupTaskRuntimeState(taskId);
  broadcastQueueStatus();
}

function cleanupExpiredTasks() {
  const ids = db.prepare('SELECT id FROM tasks WHERE expires_at IS NOT NULL AND expires_at <= ?').all(new Date().toISOString());
  let successCount = 0;
  let failCount = 0;
  for (const row of ids) {
    broadcastTaskExpired(row.id);
    try {
      deleteTask(row.id);
      successCount++;
    } catch (error) {
      failCount++;
      console.warn(`[cleanup] 过期任务删除失败: taskId=${row.id}`, error?.message || error);
    }
  }
  if (ids.length > 0) {
    console.log(`[cleanup] 本轮过期清理: 检查${ids.length}个任务, 成功${successCount}个, 失败${failCount}个`);
  }
}

// ===== WebSocket broadcasting =====

function safeSendJson(ws, payload) {
  try {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.warn('[ws] send failed', error?.message || error);
  }
}

function broadcastTask(taskId) {
  if (!taskId) return;
  let cachedPayload;
  for (const [ws, set] of taskSubscriptions) {
    if (!set.has(taskId)) continue;
    if (cachedPayload === undefined) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      const task = serializeTask(row) || { id: taskId, status: 'expired', error: '该任务已超出取回时间' };
      cachedPayload = { type: 'task', task };
    }
    safeSendJson(ws, cachedPayload);
    if (cachedPayload.task.status === 'completed' || cachedPayload.task.status === 'failed' || cachedPayload.task.status === 'expired') {
      set.delete(taskId);
    }
  }
}

function broadcastTaskExpired(taskId) {
  const payload = { type: 'task', task: { id: taskId, status: 'expired', error: '该任务已超出取回时间' } };
  for (const [ws, set] of taskSubscriptions) {
    if (!set.has(taskId)) continue;
    safeSendJson(ws, payload);
    set.delete(taskId);
  }
}

function flushQueueBroadcast() {
  queueBroadcastTimer = null;
  if (!queueBroadcastPending) return;
  queueBroadcastPending = false;
  if (queueSubscribers.size === 0) return;
  const stats = getQueueStats();
  const payload = { type: 'queueStatus', stats };
  for (const ws of queueSubscribers) {
    safeSendJson(ws, payload);
  }
}

function broadcastQueueStatus() {
  queueBroadcastPending = true;
  if (queueBroadcastTimer) return;
  queueBroadcastTimer = setTimeout(flushQueueBroadcast, 200);
}

function handleSubscribeTasks(ws, taskIds) {
  if (!Array.isArray(taskIds)) return;
  let set = taskSubscriptions.get(ws);
  if (!set) {
    set = new Set();
    taskSubscriptions.set(ws, set);
  }
  for (const id of taskIds.slice(0, WS_MAX_TASK_IDS_PER_MESSAGE)) {
    if (typeof id !== 'string' || !id) continue;
    // 已达单连接订阅上限且是新 id 时停止，避免无限增长。
    if (!set.has(id) && set.size >= WS_MAX_SUBSCRIPTIONS_PER_SOCKET) break;
    set.add(id);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const task = serializeTask(row) || { id, status: 'expired', error: '该任务已超出取回时间' };
    safeSendJson(ws, { type: 'task', task });
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'expired') {
      set.delete(id);
    }
  }
}

function handleUnsubscribeTasks(ws, taskIds) {
  const set = taskSubscriptions.get(ws);
  if (!set || !Array.isArray(taskIds)) return;
  for (const id of taskIds) {
    set.delete(id);
  }
}

function handleSubscribeQueue(ws) {
  queueSubscribers.add(ws);
  safeSendJson(ws, { type: 'queueStatus', stats: getQueueStats() });
}

function handleClientMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    safeSendJson(ws, { type: 'error', code: 'INVALID_JSON', message: '消息不是合法 JSON' });
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    safeSendJson(ws, { type: 'error', code: 'INVALID_TYPE', message: '消息缺少 type' });
    return;
  }
  switch (msg.type) {
    case 'subscribeTasks':
      handleSubscribeTasks(ws, msg.taskIds);
      break;
    case 'unsubscribeTasks':
      handleUnsubscribeTasks(ws, msg.taskIds);
      break;
    case 'subscribeQueue':
      handleSubscribeQueue(ws);
      break;
    case 'unsubscribeQueue':
      queueSubscribers.delete(ws);
      break;
    case 'ping':
      safeSendJson(ws, { type: 'pong' });
      break;
    default:
      safeSendJson(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `未知的 type: ${msg.type}` });
  }
}

function setupWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', ws => {
    wsAlive.set(ws, { lastPong: Date.now(), missed: 0 });

    ws.on('message', data => {
      handleClientMessage(ws, data.toString());
    });

    ws.on('pong', () => {
      const state = wsAlive.get(ws);
      if (state) {
        state.lastPong = Date.now();
        state.missed = 0;
      }
    });

    ws.on('close', () => {
      taskSubscriptions.delete(ws);
      queueSubscribers.delete(ws);
      wsAlive.delete(ws);
    });

    ws.on('error', error => {
      console.warn('[ws] connection error', error?.message || error);
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const state = wsAlive.get(ws);
      if (!state) continue;
      if (Date.now() - state.lastPong > WS_HEARTBEAT_INTERVAL_MS + WS_PONG_GRACE_MS) {
        state.missed += 1;
        if (state.missed >= 2) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
      }
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, WS_HEARTBEAT_INTERVAL_MS).unref();

  return wss;
}

function closeHttpServer(server) {
  if (!server || typeof server.close !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function closeWebSocketServer(wss) {
  if (!wss || typeof wss.close !== 'function') return Promise.resolve();
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      // ignore
    }
  }
  return new Promise(resolve => {
    try {
      wss.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function waitForRunningTasks() {
  const running = Array.from(runningTaskPromises);
  if (running.length === 0) return;
  await Promise.allSettled(running);
}

function checkpointTaskDatabase() {
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('[shutdown] SQLite WAL checkpoint 完成', result);
  } catch (error) {
    console.warn('[shutdown] SQLite WAL checkpoint 失败', error?.message || error);
  }
}

function closeTaskDatabase() {
  try {
    db.close();
  } catch (error) {
    console.warn('[shutdown] SQLite 关闭失败', error?.message || error);
  }
}

function registerShutdownHandlers() {
  const handleShutdownSignal = signal => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      isShuttingDown = true;
      console.log(`[shutdown] 收到 ${signal}，开始优雅退出`);

      await Promise.allSettled([
        closeHttpServer(httpServerRef),
        closeWebSocketServer(wsServerRef),
      ]);

      await waitForRunningTasks();
      checkpointTaskDatabase();
      closeTaskDatabase();
      process.exit(0);
    })().catch(error => {
      console.error('[shutdown] 优雅退出失败', error);
      closeTaskDatabase();
      process.exit(1);
    });

    return shutdownPromise;
  };

  process.on('SIGTERM', () => {
    void handleShutdownSignal('SIGTERM');
  });

  process.on('SIGINT', () => {
    void handleShutdownSignal('SIGINT');
  });
}

/**
 * 前端已收妥结果，把 TTL 收到一个短宽限期即可回收。
 * 内置任务与插件任务共用同一段逻辑。
 */
function ackTask(res, taskId) {
  const ACK_GRACE_MS = 120 * 1000;
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (existing) {
    db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId,
    );
  }
  sendJson(res, 200, { ok: true });
}

async function handleApi(req, res, pathname, searchParams) {
  try {
    const apiPathname = pathname.replace(/\/+$/, '');

    if (req.method === 'GET' && apiPathname === '/api/nova/queue-status') {
      sendJson(res, 200, getQueueStats());
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/nova/prompts') {
      const promptsPath = path.join(__dirname, 'prompts.json');
      try {
        if (!fs.existsSync(promptsPath)) {
          sendJson(res, 200, []);
          return true;
        }
        const raw = fs.readFileSync(promptsPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, Array.isArray(data) ? data : []);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/nova/blacklist') {
      const blacklistPath = path.join(__dirname, 'blacklist.json');
      try {
        if (!fs.existsSync(blacklistPath)) {
          sendJson(res, 200, { keywords: [] });
          return true;
        }
        const raw = fs.readFileSync(blacklistPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, { keywords: Array.isArray(data.keywords) ? data.keywords : [] });
      } catch {
        sendJson(res, 200, { keywords: [] });
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/nova/config') {
      const env = getRuntimeEnv();
      const rawMode = String(env.PROMPT_GALLERY_MODE || '2').trim();
      const mode = ['1', '2', '3'].includes(rawMode) ? rawMode : '2';
      sendJson(
        res,
        200,
        {
          promptGalleryMode: mode,
          promptGalleryPasswordEnabled: String(env.PROMPT_GALLERY_PASSWORD || '').trim().length > 0,
        },
        {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      );
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/nova/prompt-gallery/verify') {
      const env = getRuntimeEnv();
      const expected = String(env.PROMPT_GALLERY_PASSWORD || '').trim();
      if (!expected) {
        sendJson(res, 200, { ok: true });
        return true;
      }

      const body = await readJsonBody(req);
      const password = String(body?.password || '');
      const ok = hashPromptGalleryPassword(password) === hashPromptGalleryPassword(expected);
      sendJson(res, 200, { ok });
      return true;
    }

    const imageMatch = apiPathname.match(/^\/api\/nova\/images\/([^/]+)\/(\d+)$/);
    if (req.method === 'GET' && imageMatch) {
      const taskId = imageMatch[1];
      const index = Number(imageMatch[2]);
      if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
        sendJson(res, 400, { error: 'Invalid taskId' });
        return true;
      }
      try {
        if (!fs.existsSync(IMAGE_DIR)) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        // 常见情况：subIndex=0、扩展名 png/jpg/webp，直接拼路径命中，
        // 避免对整个 IMAGE_DIR 做同步 readdir 全目录扫描（随图片数线性变慢）。
        let filePath = null;
        for (const ext of ['png', 'jpg', 'webp']) {
          const candidate = path.join(IMAGE_DIR, `${taskId}-${index}-0.${ext}`);
          if (fs.existsSync(candidate)) { filePath = candidate; break; }
        }
        // 兜底：扩展名异常或存在多子图（极少）时才回退到目录扫描。
        if (!filePath) {
          const prefix = `${taskId}-${index}-`;
          const files = fs.readdirSync(IMAGE_DIR)
            .filter(name => name.startsWith(prefix))
            .sort();
          if (files.length > 0) filePath = path.join(IMAGE_DIR, files[0]);
        }
        if (!filePath) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        const stat = fs.statSync(filePath);
        pipeFileToResponse(res, filePath, 200, {
          'Content-Type': getContentType(filePath),
          'Content-Length': stat.size,
          'Cache-Control': 'private, max-age=3600',
        });
      } catch {
        sendJson(res, 404, { error: 'Not Found' });
      }
      return true;
    }

    // ===== 图片编辑代理（切图的 AI 透明化 / 背景补齐） =====
    //
    // 与 /api/nova/proxy/text 的差别：这里转发的是 multipart/form-data（含 image 与可选 mask
    // 的二进制），所以**不解析请求体**，原样透传字节流，只替换鉴权头。
    // 凭据走自定义头而不是表单字段，正是为了不必解析 multipart。
    //
    // 仅支持 openai 协议：/v1/images/edits 的 mask 语义只有它有，
    // 前端已在模型选择器层过滤（见 isSliceCapableImageModel），这里再兜一次。
    if (req.method === 'POST' && apiPathname === '/api/nova/proxy/image-edit') {
      try {
        const baseUrl = req.headers['x-nova-base-url'];
        const apiKey = req.headers['x-nova-api-key'];
        if (!baseUrl || !apiKey) {
          sendJson(res, 400, { error: 'Missing x-nova-base-url or x-nova-api-key' });
          return true;
        }

        const contentType = String(req.headers['content-type'] || '');
        if (!contentType.toLowerCase().includes('multipart/form-data')) {
          sendJson(res, 400, { error: '图片编辑代理只接受 multipart/form-data' });
          return true;
        }

        const rawBody = await readRawBody(req, MAX_IMAGE_EDIT_BODY_BYTES);
        const normalizedBaseUrl = normalizeProtocolBaseUrl('openai', String(baseUrl));

        const upstream = await fetchWithTimeout(`${normalizedBaseUrl}/v1/images/edits`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'Authorization': `Bearer ${apiKey}`,
          },
          body: rawBody,
        });

        // 响应可能是 JSON（b64_json / url）也可能是图片字节，一律按原样回传，
        // 由前端的 readImageResponse 统一判别。
        const upstreamType = upstream.headers.get('content-type') || 'application/json';
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'Content-Type': upstreamType,
          'Content-Length': buffer.length,
          'Cache-Control': 'no-store',
        });
        res.end(buffer);
      } catch (error) {
        if (error && error.statusCode === 413) {
          sendJson(res, 413, { error: error.message });
        } else if (error && error.message && /abort|timeout/i.test(error.message)) {
          sendJson(res, 504, { error: '图片编辑请求上游超时' });
        } else {
          sendJson(res, 502, { error: normalizeError(error) });
        }
      }
      return true;
    }

    // ===== 文本 AI 代理（流式 + 非流式，多文本协议） =====
    if (req.method === 'POST' && apiPathname === '/api/nova/proxy/text') {
      try {
        const body = await readJsonBody(req);
        const { protocol, baseUrl, apiKey, model, stream, requestBody } = body;
        if (!baseUrl || !apiKey) {
          sendJson(res, 400, { error: 'Missing baseUrl or apiKey' });
          return true;
        }

        const normalizedBaseUrl = normalizeProtocolBaseUrl(protocol, baseUrl);
        let targetUrl;
        const authHeaders = { 'Content-Type': 'application/json' };

        if (protocol === 'google' || protocol === 'google-gemini') {
          targetUrl = stream
            ? `${normalizedBaseUrl}/v1beta/models/${encodeURIComponent(model || '')}:streamGenerateContent?alt=sse`
            : `${normalizedBaseUrl}/v1beta/models/${encodeURIComponent(model || '')}:generateContent`;
          authHeaders['x-goog-api-key'] = apiKey;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        } else if (protocol === 'anthropic-messages') {
          targetUrl = `${normalizedBaseUrl}/v1/messages`;
          authHeaders['x-api-key'] = apiKey;
          authHeaders['anthropic-version'] = '2023-06-01';
        } else if (protocol === 'openai-chat-completions') {
          targetUrl = `${normalizedBaseUrl}/v1/chat/completions`;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        } else {
          targetUrl = `${normalizedBaseUrl}/v1/responses`;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        }

        if (stream) {
          authHeaders['Accept'] = 'text/event-stream';
        }

        let forwardedBody;
        if (requestBody) {
          forwardedBody = requestBody;
        } else {
          const clean = { ...body };
          delete clean.protocol;
          delete clean.baseUrl;
          delete clean.apiKey;
          delete clean.model;
          delete clean.stream;
          delete clean.requestBody;
          forwardedBody = clean;
        }

        const upstream = await fetchWithTimeout(targetUrl, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(forwardedBody),
        });

        if (stream && upstream.ok) {
          res.writeHead(upstream.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); return true; }
              res.write(value);
            }
          } catch {
            res.end();
          }
          return true;
        }

        let data = null;
        try { data = await upstream.json(); } catch { /* ignore */ }
        sendJson(res, upstream.status, data || { error: `上游返回 ${upstream.status}` });
      } catch (error) {
        if (error && error.message && /abort|timeout/i.test(error.message)) {
          sendJson(res, 504, { error: '代理请求上游超时' });
        } else {
          sendJson(res, 502, { error: normalizeError(error) });
        }
      }
      return true;
    }

    // ===== 模型检查代理（按协议查询模型列表） =====
    if ((req.method === 'GET' || req.method === 'POST') && apiPathname === '/api/nova/proxy/models') {
      try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const headerBaseUrl = firstHeaderValue(req.headers['x-nova-base-url']);
        const headerApiKey = firstHeaderValue(req.headers['x-nova-api-key']);
        let baseUrl = headerBaseUrl || parsed.searchParams.get('baseUrl');
        let apiKey = headerApiKey || parsed.searchParams.get('apiKey');
        let protocol = parsed.searchParams.get('protocol') || 'openai';
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          baseUrl = body.baseUrl || headerBaseUrl || baseUrl;
          apiKey = body.apiKey || headerApiKey || apiKey;
          protocol = body.protocol || protocol;
        }
        if (!baseUrl || !apiKey) {
          sendJson(res, 400, { error: 'Missing baseUrl or apiKey' });
          return true;
        }

        const normalizedBaseUrl = normalizeProtocolBaseUrl(protocol, baseUrl);
        let modelsUrl = `${normalizedBaseUrl}/v1/models`;
        const headers = {};

        if (protocol === 'google' || protocol === 'google-gemini') {
          modelsUrl = `${normalizedBaseUrl}/v1beta/models`;
          headers['x-goog-api-key'] = apiKey;
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (protocol === 'anthropic-messages') {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetchWithTimeout(modelsUrl, { method: 'GET', headers });
        let data = null;
        try { data = await response.json(); } catch { /* ignore */ }
        sendJson(res, response.status, data);
      } catch (error) {
        sendJson(res, 502, { error: normalizeError(error) });
      }
      return true;
    }

    // ===== 浏览器 CDP 工具（连接本机 Chrome 抓取淘宝商品素材） =====
    // CDP_ENABLED 为启动级开关：置 false 时返回明确指导说明的 404。
    if (apiPathname.startsWith('/api/nova/cdp/')) {
      if (!CDP_ENABLED) {
        sendJson(res, 404, {
          error: '浏览器 CDP 功能未启用，请在 backend/.env 中配置 NOVA_CDP_ENABLED=true 并重启服务。',
          code: 'CDP_DISABLED',
        });
        return true;
      }
      // 只信任 TCP socket 的真实来源。带 X-Forwarded-For 时视为经代理，必须再校验令牌。
      const cdpAuth = authorizeCdpRequest(req);
      if (!cdpAuth.ok) {
        sendJson(res, cdpAuth.status, {
          error: cdpAuth.error,
          code: cdpAuth.code,
        });
        return true;
      }
      try {
        if (req.method === 'GET' && apiPathname === '/api/nova/cdp/status') {
          // 状态探测的本职就是判断可达性：浏览器不在线（或探测出错）都按
          // 200 + reachable:false 返回，不向前端抛错。
          const cdpConfig = getCdpConfig();
          try {
            const status = await getCdpStatus(cdpConfig);
            sendJson(res, 200, { host: cdpConfig.host, port: cdpConfig.port, ...status });
          } catch (statusError) {
            console.warn('[cdp] 浏览器状态探测失败:', statusError?.message || statusError);
            sendJson(res, 200, { reachable: false, host: cdpConfig.host, port: cdpConfig.port });
          }
          return true;
        }

        if (req.method === 'GET' && apiPathname === '/api/nova/cdp/config') {
          const cdpConfig = getCdpConfig();
          sendJson(res, 200, { host: cdpConfig.host, port: cdpConfig.port });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/config') {
          const body = await readJsonBody(req);
          const nextPort = parseIntegerEnv(body?.port, 0, { min: 1, max: 65535 });
          if (!nextPort) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少有效的 port 参数（1-65535）。');
          }
          const current = readCdpRuntimeConfig();
          const probe = await getCdpStatus({ ...getCdpConfig(), port: nextPort });
          if (!probe.reachable) {
            const available = await isPortAvailable(nextPort);
            if (!available) {
              throw createHttpError(409, 'PORT_IN_USE', `端口 ${nextPort} 已被占用，且不是有效的浏览器调试端口。`);
            }
          }
          writeCdpRuntimeConfig({ ...current, port: nextPort });
          const cdpConfig = getCdpConfig();
          const status = await getCdpStatus(cdpConfig);
          sendJson(res, 200, { host: cdpConfig.host, port: cdpConfig.port, ...status });
          return true;
        }

        if (req.method === 'GET' && apiPathname === '/api/nova/cdp/targets') {
          const result = await listPageTargets(getCdpConfig());
          const targets = Array.isArray(result) ? result : (Array.isArray(result?.targets) ? result.targets : []);
          sendJson(res, 200, { targets });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/extract') {
          const body = await readJsonBody(req);
          const targetId = String(body?.targetId || '').trim();
          if (!targetId) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 targetId 参数。');
          }
          const product = await evaluateInPage({ ...getCdpConfig(), targetId, expression: TAOBAO_EXTRACT_EXPRESSION });
          const title = String(product?.title || '').trim();
          const mainImages = Array.isArray(product?.mainImages) ? product.mainImages : [];
          if (!title && mainImages.length === 0) {
            throw createHttpError(422, 'EXTRACT_EMPTY', '未能从当前页面提取到商品标题或主图，该页面可能不是淘宝/天猫商品详情页。');
          }
          sendJson(res, 200, { product });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/fetch-image') {
          const body = await readJsonBody(req);
          const targetId = String(body?.targetId || '').trim();
          if (!targetId) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 targetId 参数。');
          }
          const cdpConfig = getCdpConfig();
          const fetchOneToDisk = async imageUrl => {
            // 同一 URL 抓过就直接复用，避免每轮对话/重抓重复下载同一批图
            const cached = findCdpImageByUrl(imageUrl);
            if (cached) return cached.localUrl;
            const resource = await fetchResourceInPage({ ...cdpConfig, targetId, url: imageUrl });
            const imageBuffer = resource?.data;
            if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
              throw new Error('浏览器未返回有效的图片数据。');
            }
            return saveCdpImageToDisk(imageUrl, imageBuffer, resource?.mimeType).localUrl;
          };

          if (body?.urls !== undefined) {
            if (!Array.isArray(body.urls) || body.urls.length === 0) {
              throw createHttpError(400, 'INVALID_PARAMS', 'urls 必须是非空数组。');
            }
            if (body.urls.length > 30) {
              throw createHttpError(400, 'INVALID_PARAMS', '单次最多抓取 30 张图片，请分批提交。');
            }
            const results = [];
            for (const item of body.urls) {
              const imageUrl = String(item || '').trim();
              if (!imageUrl) {
                results.push({ url: item, error: '图片地址为空。' });
                continue;
              }
              try {
                results.push({ url: imageUrl, localUrl: await fetchOneToDisk(imageUrl) });
              } catch (itemError) {
                const message = itemError instanceof CdpError
                  ? itemError.message
                  : normalizeError(itemError);
                results.push({ url: imageUrl, error: message });
              }
            }
            sendJson(res, 200, { results });
            return true;
          }

          const imageUrl = String(body?.url || '').trim();
          if (!imageUrl) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 url 或 urls 参数。');
          }
          sendJson(res, 200, { localUrl: await fetchOneToDisk(imageUrl) });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/screenshot') {
          const body = await readJsonBody(req);
          const targetId = String(body?.targetId || '').trim();
          if (!targetId) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 targetId 参数。');
          }
          const pngBuffer = await capturePageScreenshot({ ...getCdpConfig(), targetId, fullPage: Boolean(body?.fullPage) });
          if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
            throw new Error('浏览器未返回有效的截图数据。');
          }
          const fileName = `shot_${Date.now()}.png`;
          fs.writeFileSync(path.join(CDP_DIR, fileName), pngBuffer);
          sendJson(res, 200, { localUrl: `/api/nova/cdp/products/${fileName}` });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/launch') {
          await readJsonBody(req); // body 约定为 {}，仍读取以排空请求流
          if (launchInProgress) {
            sendJson(res, 200, { ok: false, message: '浏览器正在启动中，请稍候重试。' });
            return true;
          }
          const cdpConfig = getCdpConfig();
          const existing = await getCdpStatus(cdpConfig);
          if (existing.reachable) {
            sendJson(res, 200, {
              ok: true,
              reused: true,
              message: `已连接到现有调试浏览器（端口 ${cdpConfig.port}，${existing.browser || '浏览器'}）。`,
              port: cdpConfig.port,
              browser: existing.browser,
            });
            return true;
          }
          const portAvailable = await isPortAvailable(cdpConfig.port);
          if (!portAvailable) {
            throw createHttpError(409, 'PORT_IN_USE', `端口 ${cdpConfig.port} 已被占用，且不是有效的浏览器调试端口。`);
          }
          if (!cdpConfig.launchEnabled) {
            throw createHttpError(403, 'CDP_LAUNCH_DISABLED', `服务器已禁用自动启动浏览器（NOVA_CDP_LAUNCH_ENABLED=false）。请手动启动 Chrome 并附加 --remote-debugging-port=${cdpConfig.port} 参数后重试。`);
          }
          const overridePath = String(process.env.NOVA_CHROME_PATH || '').trim();
          let executable = null;
          if (overridePath) {
            if (!fs.existsSync(overridePath)) {
              sendJson(res, 200, { ok: false, message: `NOVA_CHROME_PATH 指定的浏览器路径不存在：${overridePath}，请修正后重试。` });
              return true;
            }
            executable = overridePath;
          } else {
            executable = findChromeExecutable();
          }
          if (!executable) {
            sendJson(res, 200, { ok: false, message: `未找到本机 Chrome 浏览器。请安装 Chrome，或设置 NOVA_CHROME_PATH 指向浏览器可执行文件；也可以手动启动 Chrome 并附加 --remote-debugging-port=${cdpConfig.port} 参数。` });
            return true;
          }
          const profileDir = path.join(path.dirname(CDP_DIR), 'chrome-profile');
          fs.mkdirSync(profileDir, { recursive: true });
          launchInProgress = true;
          const child = spawn(executable, [
            `--remote-debugging-port=${cdpConfig.port}`,
            `--remote-debugging-address=127.0.0.1`,
            `--user-data-dir=${profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
          ], { detached: true, stdio: 'ignore' });
          child.on('error', launchError => {
            console.warn('[cdp] 启动浏览器进程失败:', launchError?.message || launchError);
            launchInProgress = false;
          });
          child.unref();
          // 等调试端口真正起来再返回，避免 Agent 立刻 open 时还是连不上
          const launchDeadline = Date.now() + 15000;
          let status = { reachable: false };
          while (Date.now() < launchDeadline) {
            status = await getCdpStatus(cdpConfig);
            if (status.reachable) break;
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          if (!status.reachable) {
            launchInProgress = false;
            sendJson(res, 200, {
              ok: false,
              message: `已尝试启动浏览器（调试端口 ${cdpConfig.port}），但端口仍未就绪。请确认本机已安装 Chrome/Edge，或手动用 --remote-debugging-port=${cdpConfig.port} 启动后再试。`,
              profileDir,
              port: cdpConfig.port,
            });
            return true;
          }
          launchInProgress = false;
          sendJson(res, 200, {
            ok: true,
            message: `已启动调试浏览器（端口 ${cdpConfig.port}，${status.browser || '浏览器'}）。这是独立配置，不含日常浏览器登录态；第一次用请在该窗口登录淘宝。`,
            profileDir,
            port: cdpConfig.port,
            browser: status.browser,
          });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/evaluate') {
          const cdpConfig = getCdpConfig();
          // 任意表达式执行风险较高，默认关闭，需显式开启。
          if (!cdpConfig.evalEnabled) {
            throw createHttpError(403, 'CDP_EVAL_DISABLED', '任意表达式执行默认关闭（NOVA_CDP_EVAL_ENABLED=false）。确有调试需要时，请在 .env 中设置 NOVA_CDP_EVAL_ENABLED=true 后重试。');
          }
          const body = await readJsonBody(req);
          const targetId = String(body?.targetId || '').trim();
          const expression = String(body?.expression || '');
          if (!targetId || !expression.trim()) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 targetId 或 expression 参数。');
          }
          const value = await evaluateInPage({ ...cdpConfig, targetId, expression });
          sendJson(res, 200, { value: value === undefined ? null : value });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/open') {
          const body = await readJsonBody(req);
          const url = String(body?.url || '').trim();
          if (!url || !/^https?:\/\//i.test(url)) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 url 参数或协议不受支持（仅支持 http/https）。');
          }
          const cdpConfig = getCdpConfig();
          let target;
          let reused = false;
          try {
            const targets = await listPageTargets(cdpConfig);
            target = targets.find(item => item.url === url);
            reused = Boolean(target);
          } catch {
            // 标签页列表不可用时保持原有新开标签页路径。
          }
          if (!target) target = await openTarget({ ...cdpConfig, url });
          if (!reused) {
            // best-effort 等待页面加载：每 500ms 查一次 document.readyState，直到
            // 'complete' 或累计 10 秒；等待过程中的任何错误都忽略，不影响返回。
            const waitDeadline = Date.now() + 10000;
            while (Date.now() < waitDeadline) {
              try {
                const readyState = await evaluateInPage({ ...cdpConfig, targetId: target.id, expression: 'document.readyState' });
                if (readyState === 'complete') break;
              } catch {
                // 忽略等待过程中的错误
              }
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          const response = { targetId: target.id, url };
          if (reused) response.reused = true;
          sendJson(res, 200, response);
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/read-page') {
          const body = await readJsonBody(req);
          const targetId = String(body?.targetId || '').trim();
          if (!targetId) {
            throw createHttpError(400, 'INVALID_PARAMS', '缺少 targetId 参数。');
          }
          const maxChars = parseIntegerEnv(body?.maxChars, READ_PAGE_MAX_CHARS_DEFAULT, { min: 1, max: READ_PAGE_MAX_CHARS_LIMIT });
          // 固定表达式注入（不走 /cdp/evaluate 的开放入口），避免任意脚本执行。
          const result = await evaluateInPage({ ...getCdpConfig(), targetId, expression: buildReadPageExpression(maxChars) });
          const payload = result || {};
          sendJson(res, 200, {
            title: typeof payload.title === 'string' ? payload.title : '',
            url: typeof payload.url === 'string' ? payload.url : '',
            text: typeof payload.text === 'string' ? payload.text : '',
          });
          return true;
        }

        if (req.method === 'POST' && apiPathname === '/api/nova/cdp/purge-images') {
          const body = await readJsonBody(req);
          sendJson(res, 200, { deleted: purgeCdpProductFiles(body?.files) });
          return true;
        }

        // 已落盘商品素材的静态服务（防路径穿越）
        const productFileMatch = apiPathname.match(/^\/api\/nova\/cdp\/products\/(.+)$/);
        if (req.method === 'GET' && productFileMatch) {
          let fileName;
          try {
            fileName = decodeURIComponent(productFileMatch[1]);
          } catch {
            throw createHttpError(400, 'INVALID_PARAMS', '商品素材文件名编码无效。');
          }
          if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            throw createHttpError(400, 'INVALID_PARAMS', '非法的商品素材文件名。');
          }
          const cdpDirResolved = path.resolve(CDP_DIR);
          const filePath = path.resolve(cdpDirResolved, fileName);
          if (!filePath.startsWith(cdpDirResolved + path.sep)) {
            throw createHttpError(400, 'INVALID_PARAMS', '非法的商品素材文件名。');
          }
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            sendJson(res, 404, { error: 'Not Found' });
            return true;
          }
          const stat = fs.statSync(filePath);
          pipeFileToResponse(res, filePath, 200, {
            'Content-Type': getContentType(filePath),
            'Content-Length': stat.size,
            'Cache-Control': 'private, max-age=3600',
          });
          return true;
        }

        sendJson(res, 404, { error: 'Not Found' });
      } catch (error) {
        sendCdpError(res, error);
      }
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/nova/tasks') {
      const body = await readJsonBody(req);
      const taskId = createTask(body, req);
      sendJson(res, 202, { taskId });
      return true;
    }

    // ===== 视频插件 =====

    if (req.method === 'GET' && apiPathname === '/api/nova/plugins') {
      // ?reload=1 重新扫描插件目录，供管理员放完插件后免重启生效。
      // 代价只是读几个小 JSON 文件，因此不额外设限。
      if (searchParams?.get('reload') === '1') pluginRegistry.reload();
      sendJson(res, 200, {
        ...pluginRegistry.describeRegistryForClient(),
        mediaLimits: pluginMedia.getLimitsForClient(),
      });
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/nova/plugin-media') {
      const pluginId = String(searchParams?.get('pluginId') || '');
      const kind = String(searchParams?.get('kind') || 'images');
      const plugin = pluginRegistry.getPlugin(pluginId);
      if (!plugin) {
        throw createHttpError(404, 'PLUGIN_NOT_FOUND', `插件 ${pluginId} 未安装或加载失败`);
      }
      const uploaded = await pluginMedia.handleUpload(req, kind, plugin);
      sendJson(res, 200, uploaded);
      return true;
    }

    // 素材回读：上游要匿名拉取，所以这里不鉴权（文件名是随机 UUID）
    const pluginMediaMatch = apiPathname.match(/^\/api\/nova\/plugin-media\/([^/]+)$/);
    if (pluginMediaMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      pluginMedia.serveFile(res, decodeURIComponent(pluginMediaMatch[1]));
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/nova/plugin-tasks') {
      const body = await readJsonBody(req);
      const taskId = createPluginTask(body, req);
      sendJson(res, 202, { taskId });
      return true;
    }

    const pluginTaskMatch = apiPathname.match(/^\/api\/nova\/plugin-tasks\/([^/]+)(?:\/(ack))?$/);
    if (pluginTaskMatch) {
      const pluginTaskId = decodeURIComponent(pluginTaskMatch[1]);
      const pluginAction = pluginTaskMatch[2];

      if (req.method === 'GET' && !pluginAction) {
        const task = await getPluginTaskForClient(pluginTaskId);
        sendJson(res, task ? 200 : 404, task || { id: pluginTaskId, status: 'expired', error: '该任务已超出取回时间' });
        return true;
      }

      if (req.method === 'POST' && pluginAction === 'ack') {
        ackTask(res, pluginTaskId);
        return true;
      }
    }

    const match = apiPathname.match(/^\/api\/nova\/tasks\/([^/]+)(?:\/(ack))?$/);
    if (!match) return false;
    const taskId = decodeURIComponent(match[1]);
    const action = match[2];

    if (req.method === 'GET' && !action) {
      const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
      sendJson(res, task ? 200 : 404, task || { id: taskId, status: 'expired', error: '该任务已超出取回时间' });
      return true;
    }

    if (req.method === 'POST' && action === 'ack') {
      ackTask(res, taskId);
      return true;
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  } catch (error) {
    if (isHttpError(error)) {
      sendHttpError(res, error);
    } else if (error && typeof error.statusCode === 'number') {
      sendJson(res, error.statusCode, { error: normalizeError(error) });
    } else {
      sendJson(res, 400, { error: normalizeError(error) });
    }
    return true;
  }
}

initDatabase();
ensureImageDir();
ensureCdpDir();
cleanupExpiredTasks();
pluginMedia.cleanupExpired();
// 启动时把插件扫一遍：加载成功/失败都会打日志，管理员放错文件时立刻能看到
pluginRegistry.listPlugins();
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS).unref();
setInterval(() => pluginMedia.cleanupExpired(), CLEANUP_INTERVAL_MS).unref();
setInterval(cleanupRateLimitBuckets, CLEANUP_INTERVAL_MS).unref();

const startServer = () => {
  const wss = setupWebSocketServer();
  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`);
    if (parsedUrl.pathname?.startsWith('/api/nova/')) {
      const handled = await handleApi(req, res, parsedUrl.pathname, parsedUrl.searchParams);
      if (handled || res.headersSent || res.writableEnded) return;
    }
    if (!IS_DEV) {
      if (serveStatic(req, res, parsedUrl.pathname || '/')) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    handle(req, res, req.url || '/');
  });

  const nextUpgradeHandler = IS_DEV && typeof app.getUpgradeHandler === 'function'
    ? app.getUpgradeHandler()
    : null;

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/api/nova/ws') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      return;
    }
    if (nextUpgradeHandler) {
      nextUpgradeHandler(req, socket, head);
      return;
    }
    socket.destroy();
  });

  httpServer.listen(PORT, HOSTNAME, () => {
    const localUrl = `http://localhost:${PORT}`;
    const listenUrl = `http://${HOSTNAME}:${PORT}`;
    console.log(`Nova Studio server ready on ${localUrl}`);
    if (HOSTNAME !== 'localhost' && HOSTNAME !== '127.0.0.1') {
      console.log(`Listening on ${listenUrl}`);
    }
  });

  wsServerRef = wss;
  httpServerRef = httpServer;
};

module.exports = { isLoopbackAddress };

registerShutdownHandlers();

if (IS_DEV) {
  app.prepare().then(startServer);
} else {
  startServer();
}
