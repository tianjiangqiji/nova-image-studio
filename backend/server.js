const http = require('http');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const next = process.env.NODE_ENV !== 'production' ? require('next') : null;
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

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
const TASK_TTL_MS = 12 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IMAGE_STREAM_UNSUPPORTED_PATTERN = /(?:stream.*(?:unsupported|not supported|unknown|unrecognized|invalid)|(?:unsupported|not supported|unknown|unrecognized|invalid).*stream|stream.*(?:不支持|未知|无效)|(?:不支持|未知|无效).*stream)/i;
// 开源版：不再硬编码模型列表，由前端通过 protocol 字段指定协议类型
const VALID_PROTOCOLS = new Set(['google', 'openai']);
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
const taskRefImages = new Map();

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
  const acceptingNewTasks = !isRejectNewTasksEnabled();

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
  if (!VALID_PROTOCOLS.has(body.protocol)) throw new Error('协议类型无效，必须为 google 或 openai');
  if (body.mode !== 'text-to-image' && body.mode !== 'image-to-image') throw new Error('任务模式无效');
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) throw new Error('提示词不能为空');
  if (typeof body.model !== 'string' || body.model.trim().length === 0) throw new Error('模型名称不能为空');
  if (!Number.isInteger(body.parallelCount) || body.parallelCount < 1 || body.parallelCount > 4) throw new Error('并发数量无效');

  if (!Array.isArray(body.images)) body.images = [];
  body.baseUrl = normalizeProtocolBaseUrl(body.protocol, body.baseUrl);
  if (!body.baseUrl) throw new Error('缺少 API 基础地址');
  // 开源版：不做模型级参数规范化，前端负责传递正确的参数，后端无条件透传
}

function createTask(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) {
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

function getGptImageRequestAdvancedParams(request) {
  return normalizeGptImageAdvancedParams(request);
}

function createGptImageRequestInit(apiKey, request, resolvedSize, options = {}) {
  const prompt = request.prompt;
  const advancedParams = getGptImageRequestAdvancedParams(request);
  const stream = Boolean(options.stream);

  if (request.mode === 'image-to-image') {
    const formData = new FormData();
    formData.append('model', request.model);
    formData.append('prompt', prompt);
    formData.append('n', '1');
    if (stream) {
      formData.append('stream', 'true');
    }
    if (advancedParams) {
      formData.append('quality', advancedParams.quality);
      formData.append('background', advancedParams.background);
      formData.append('output_format', 'png');
      if (advancedParams.style === 'vivid' || advancedParams.style === 'natural') {
        formData.append('style', advancedParams.style);
      }
    }
    if (resolvedSize) {
      formData.append('size', resolvedSize);
    }

    request.images.forEach((img, index) => {
      const mimeType = img.mimeType || 'image/png';
      const extension = mimeType.split('/')[1] || 'png';
      const bytes = Buffer.from(img.data, 'base64');
      const blob = new Blob([bytes], { type: mimeType });
      formData.append('image', blob, `image-${index}.${extension}`);
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
    ...(stream ? { stream: true } : {}),
    ...(resolvedSize ? { size: resolvedSize } : {}),
    ...(advancedParams ? {
      quality: advancedParams.quality,
      background: advancedParams.background,
      output_format: 'png',
      ...(advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}),
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

  return '';
}

function getUpstreamErrorText(text) {
  const trimmed = String(text || '').trim();
  const data = parseJsonSafely(trimmed);
  const message = getErrorMessageFromPayload(data) || getMessageFromPayload(data);
  if (message) return message;
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
    const errorText = getUpstreamErrorText(responseText);
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
    return requestGptImage(apiKey, request, resolveGptImageRequestSize(request), { baseUrl });
  }
  // 默认走 Google Gemini 协议
  return generateNovaGeminiImage(apiKey, request, { baseUrl });
}

function extractGeminiImagePayload(data) {
  const imagePart = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data || part?.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) throw new Error('响应中无图片数据');
  return inlineData.data;
}

async function generateNovaGeminiImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveNovaApiBaseUrl();
  const parts = [
    { text: request.prompt },
    ...request.images.map(img => ({ inlineData: { data: img.data, mimeType: img.mimeType } })),
  ];
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
        imageConfig: { imageSize: request.outputSize, aspectRatio: request.aspectRatio },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败: ${response.status} ${errorText}`);
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
    const task = db.prepare('SELECT request_json FROM tasks WHERE id = ?').get(taskId);
    const req = task ? JSON.parse(task.request_json) : null;
    const imageSlots = req?.parallelCount || 1;

    // 容量足够 → 放行。容量不足时唯一例外：当前空闲（activeCount===0）且该任务
    // 自身就超过总并发，允许其独占运行（否则永远无法被调度）；其余情况一律等待
    // 在飞任务腾出名额。
    const fitsWithinLimit = activeCount + imageSlots <= maxConcurrency;
    const oversizedTaskCanRunAlone = activeCount === 0 && imageSlots > maxConcurrency;
    if (!fitsWithinLimit && !oversizedTaskCanRunAlone) break;

    queue.shift();
    activeCount += imageSlots;
    runTask(taskId).finally(() => {
      activeCount -= imageSlots;
      drainQueue();
    });
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

function serializeTask(task) {
  if (!task) return null;
  if (task.expires_at && Date.parse(task.expires_at) <= Date.now()) {
    return { id: task.id, status: 'expired', error: '该任务已超出取回时间' };
  }
  const result = task.result_json ? JSON.parse(task.result_json) : undefined;
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
  };
}

function deleteTask(taskId) {
  deleteTaskImageFiles(taskId);
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

async function handleApi(req, res, pathname) {
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
    if (req.method === 'GET' && apiPathname === '/api/nova/proxy/models') {
      try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const baseUrl = parsed.searchParams.get('baseUrl');
        const apiKey = parsed.searchParams.get('apiKey');
        const protocol = parsed.searchParams.get('protocol') || 'openai';
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

    if (req.method === 'POST' && apiPathname === '/api/nova/tasks') {
      const body = await readJsonBody(req);
      const taskId = createTask(body, req);
      sendJson(res, 202, { taskId });
      return true;
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
      const ACK_GRACE_MS = 120 * 1000;
      const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
      if (existing) {
        db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(
          new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId
        );
      }
      sendJson(res, 200, { ok: true });
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
cleanupExpiredTasks();
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS).unref();
setInterval(cleanupRateLimitBuckets, CLEANUP_INTERVAL_MS).unref();

const startServer = () => {
  const wss = setupWebSocketServer();
  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`);
    if (parsedUrl.pathname?.startsWith('/api/nova/')) {
      const handled = await handleApi(req, res, parsedUrl.pathname);
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
    console.log(`Nova Image server ready on ${localUrl}`);
    if (HOSTNAME !== 'localhost' && HOSTNAME !== '127.0.0.1') {
      console.log(`Listening on ${listenUrl}`);
    }
  });
};

if (IS_DEV) {
  app.prepare().then(startServer);
} else {
  startServer();
}
