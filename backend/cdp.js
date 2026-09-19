const http = require('http');
const { WebSocket } = require('ws');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 20000;
// 单张图片体积硬上限：淘宝原图偶尔会爆出几十 MB 的大图，无上限落盘会把磁盘打满。
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// 本机调试端口刚起来时，带 HTTP_PROXY / NODE_USE_ENV_PROXY 的 fetch 会把
// 127.0.0.1 请求拐进代理并立刻 ECONNREFUSED。CDP 一律走 Node http，不经代理。
const LOOPBACK_RETRY = 3;
const LOOPBACK_RETRY_DELAY_MS = 80;
const TRANSIENT_NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

class CdpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

function parseIpv4(host) {
  const parts = String(host || '').trim().split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  if (value.startsWith('::ffff:')) return isLoopbackHost(value.slice(7));
  const octets = parseIpv4(value);
  return Boolean(octets && octets[0] === 127);
}

function normalizeCdpHost(host) {
  const value = String(host || '').trim();
  return isLoopbackHost(value) ? value : DEFAULT_HOST;
}

function isBlockedIpv4(octets) {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedIpv6(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (value === '::1') return true;
  if (value.startsWith('::ffff:')) {
    const mapped = parseIpv4(value.slice(7));
    return !mapped || isBlockedIpv4(mapped);
  }
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);
  if (host.includes(':')) return isBlockedIpv6(host);
  return false;
}

function isSafeCdpImageUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return !isBlockedHostname(url.hostname);
  } catch {
    return false;
  }
}

function normalizeOptions(options = {}) {
  return {
    host: normalizeCdpHost(options.host),
    port: Number(options.port) || DEFAULT_PORT,
    timeoutMs: Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
  };
}

function cdpHttpRequest(opts, { method = 'GET', apiPath }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: opts.host,
      port: opts.port,
      path: apiPath,
      method,
      timeout: opts.timeoutMs,
      family: 4,
      agent: false,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => {
      const error = new Error(`timeout ${opts.timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    req.on('error', reject);
    req.end();
  });
}

async function cdpHttpRequestWithRetry(opts, request) {
  const attempts = isLoopbackHost(opts.host) ? LOOPBACK_RETRY : 1;
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await cdpHttpRequest(opts, request);
    } catch (error) {
      lastError = error;
      if (error && TRANSIENT_NETWORK_ERRORS.has(error.code) && i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, LOOPBACK_RETRY_DELAY_MS * (i + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function parseCdpJson(response, apiPath) {
  if (!response.ok) {
    throw new CdpError('CDP_PROTOCOL', `浏览器调试接口 ${apiPath} 返回异常状态：HTTP ${response.status}`);
  }
  try {
    return JSON.parse(response.text);
  } catch (error) {
    throw new CdpError('CDP_PROTOCOL', `浏览器调试接口 ${apiPath} 返回的不是合法 JSON：${error.message}`);
  }
}

// HTTP 探测（/json/version、/json/list）：浏览器没启动、端口不通、超时统一归为
// CDP_UNREACHABLE，由上层映射成 502 提示用户启动带调试端口的 Chrome。
async function httpGetJson(opts, apiPath) {
  let response;
  try {
    response = await cdpHttpRequestWithRetry(opts, { method: 'GET', apiPath });
  } catch (error) {
    throw new CdpError('CDP_UNREACHABLE', `无法连接浏览器调试端口（${opts.host}:${opts.port}）：${error.message}`);
  }
  return parseCdpJson(response, apiPath);
}

// 状态探测的语义就是"能不能连"，任何失败都只体现为 reachable:false，不向上抛错。
async function getCdpStatus(options) {
  const opts = normalizeOptions(options);
  try {
    const info = await httpGetJson(opts, '/json/version');
    return {
      reachable: true,
      browser: info.Browser,
      version: info['Protocol-Version'],
    };
  } catch {
    return { reachable: false, host: opts.host, port: opts.port };
  }
}

async function listPageTargets(options) {
  const opts = normalizeOptions(options);
  const targets = await httpGetTargetsJson(opts);
  if (!Array.isArray(targets)) {
    throw new CdpError('CDP_PROTOCOL', '浏览器调试接口 /json/list 返回格式异常');
  }
  return targets
    .filter(target => target && target.type === 'page')
    .map(target => ({ id: target.id, title: target.title || '', url: target.url || '' }));
}

// 部分 Chromium 分支（如 360ChromeX）只提供 /json，/json/list 直接 404。
// 两者返回结构一致，404 时回退 /json。
async function httpGetTargetsJson(opts) {
  try {
    return await httpGetJson(opts, '/json/list');
  } catch (error) {
    if (error instanceof CdpError && /HTTP 404/.test(error.message)) {
      return await httpGetJson(opts, '/json');
    }
    throw error;
  }
}

// 找到目标标签页并建立 WebSocket 连接；page target 的 WS 直接收 Runtime/Page 域
// 命令，无需先连 browser 级 WS 再 Target.attachToTarget。
async function connectPageWs(opts, targetId) {
  const targets = await httpGetTargetsJson(opts);
  const target = Array.isArray(targets)
    ? targets.find(item => item && item.id === targetId)
    : null;
  if (!target || !target.webSocketDebuggerUrl) {
    throw new CdpError('CDP_TARGET_NOT_FOUND', `未找到目标标签页（targetId: ${targetId}），可能已被关闭`);
  }

  const attempts = isLoopbackHost(opts.host) ? LOOPBACK_RETRY : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { agent: false });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new CdpError('CDP_UNREACHABLE', `连接标签页调试通道超时（${opts.timeoutMs}ms）`));
        }, opts.timeoutMs);
        const onOpen = () => {
          clearTimeout(timer);
          resolve();
        };
        const onError = error => {
          clearTimeout(timer);
          reject(error);
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
      });
      return ws;
    } catch (error) {
      lastError = error;
      ws.terminate();
      const retryable = error && TRANSIENT_NETWORK_ERRORS.has(error.code);
      if (!retryable || attempt >= attempts - 1) break;
      await new Promise(resolve => setTimeout(resolve, LOOPBACK_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  if (lastError && lastError.code === 'CDP_UNREACHABLE') throw lastError;
  throw new CdpError('CDP_UNREACHABLE', `连接标签页调试通道失败：${lastError?.message || '未知网络错误'}`);
}

// 在已建立的 WS 上维护自增 id 的请求表：协议层 error 响应按 CDP_PROTOCOL 拒绝，
// timeoutMs 内无应答按 CDP_TIMEOUT 拒绝；连接意外断开时挂起的请求全部失败。
function createCdpSession(ws, timeoutMs) {
  let nextId = 0;
  const pending = new Map();

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new CdpError('CDP_PROTOCOL', `浏览器调试协议错误：${message.error.message || JSON.stringify(message.error)}`));
    } else {
      entry.resolve(message.result);
    }
  });

  const failAll = error => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  ws.on('error', error => failAll(new CdpError('CDP_PROTOCOL', `调试通道异常：${error.message}`)));
  ws.on('close', () => failAll(new CdpError('CDP_PROTOCOL', '调试通道被意外关闭')));

  function sendCommand(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpError('CDP_TIMEOUT', `浏览器调试命令 ${method} 超时（${timeoutMs}ms），请确认页面未卡死后重试`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('CDP_PROTOCOL', `发送调试命令 ${method} 失败：${error.message}`));
      });
    });
  }

  return { sendCommand };
}

// 每次操作独立建立连接、finally 关闭，避免在浏览器侧留下悬挂的调试会话。
async function withPageSession(options, handler) {
  const opts = normalizeOptions(options);
  const ws = await connectPageWs(opts, options.targetId);
  const session = createCdpSession(ws, opts.timeoutMs);
  try {
    return await handler(session);
  } finally {
    try {
      ws.terminate();
    } catch {
      // 忽略关闭异常
    }
  }
}

async function evaluateInPage(options) {
  return withPageSession(options, async session => {
    const result = await session.sendCommand('Runtime.evaluate', {
      expression: String(options.expression),
      awaitPromise: true,
      returnByValue: true,
    });
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails;
      const pageError = (details.exception && (details.exception.description || details.exception.value))
        || details.text
        || '未知异常';
      throw new CdpError('CDP_PROTOCOL', `页面内执行脚本出错：${pageError}`);
    }
    return result && result.result ? result.result.value : undefined;
  });
}

async function capturePageScreenshot(options) {
  return withPageSession(options, async session => {
    await session.sendCommand('Page.enable');
    // fullPage 为 true 时截取视口之外的完整页面内容
    const result = await session.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: Boolean(options && options.fullPage),
    });
    if (!result || typeof result.data !== 'string') {
      throw new CdpError('CDP_PROTOCOL', '截图失败：浏览器未返回图像数据');
    }
    return Buffer.from(result.data, 'base64');
  });
}

function headerContentType(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const key = Object.keys(headers).find(name => String(name).toLowerCase() === 'content-type');
  return key ? String(headers[key] || '') : '';
}

async function readCdpStream(session, handle) {
  const chunks = [];
  let total = 0;
  let eof = false;
  try {
    while (!eof) {
      const result = await session.sendCommand('IO.read', { handle, size: 256 * 1024 });
      const piece = result && result.data
        ? Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8')
        : Buffer.alloc(0);
      total += piece.length;
      if (total > MAX_IMAGE_BYTES) {
        throw new CdpError('CDP_PROTOCOL', '图片超过 20MB 上限');
      }
      if (piece.length > 0) chunks.push(piece);
      eof = Boolean(result && result.eof);
    }
  } finally {
    try {
      await session.sendCommand('IO.close', { handle });
    } catch {
      // 忽略关闭异常
    }
  }
  return Buffer.concat(chunks);
}

// Chrome 自己的网络栈下载：带页面 cookie，且不受页面 JS 的 CORS 限制。
async function fetchViaChromeNetwork(session, url) {
  await session.sendCommand('Page.enable');
  await session.sendCommand('Network.enable');
  const tree = await session.sendCommand('Page.getFrameTree');
  const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
  if (!frameId) {
    throw new CdpError('CDP_PROTOCOL', '无法获取页面 frame，浏览器网络栈下载失败');
  }

  const attempts = [
    { includeCredentials: true, disableCache: false },
    { includeCredentials: false, disableCache: false },
  ];
  let lastError;
  for (const options of attempts) {
    const loaded = await session.sendCommand('Network.loadNetworkResource', {
      frameId,
      url,
      options,
    });
    const resource = loaded && loaded.resource ? loaded.resource : {};
    if (!resource.success) {
      lastError = new CdpError(
        'CDP_PROTOCOL',
        `浏览器下载图片失败：${resource.netErrorName || '未知网络错误'}${resource.httpStatusCode ? `（HTTP ${resource.httpStatusCode}）` : ''}`,
      );
      continue;
    }
    const status = typeof resource.httpStatusCode === 'number' ? resource.httpStatusCode : 0;
    if (status && (status < 200 || status >= 400)) {
      lastError = new CdpError('CDP_PROTOCOL', `浏览器下载图片失败：HTTP ${status}`);
      continue;
    }
    if (!resource.stream) {
      lastError = new CdpError('CDP_PROTOCOL', '浏览器下载图片失败：未返回数据流');
      continue;
    }
    const data = await readCdpStream(session, resource.stream);
    if (!data.length) {
      lastError = new CdpError('CDP_PROTOCOL', '浏览器下载图片失败：数据为空');
      continue;
    }
    return {
      data,
      mimeType: headerContentType(resource.headers),
      status: status || 200,
    };
  }
  throw lastError || new CdpError('CDP_PROTOCOL', '浏览器下载图片失败');
}

function pageFetchExpression(url, credentials) {
  return `(async () => {
  const response = await fetch(${JSON.stringify(url)}, { credentials: '${credentials}' });
  const status = response.status;
  const mimeType = response.headers.get('content-type') || '';
  const blob = await response.blob();
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('FileReader 读取失败'));
    reader.readAsDataURL(blob);
  });
  return { base64, mimeType, status };
})()`;
}

function decodePageFetchPayload(value) {
  const payload = value || {};
  if (typeof payload.base64 !== 'string' || !payload.base64) {
    throw new CdpError('CDP_PROTOCOL', '页面内抓取图片失败：未返回图像数据');
  }
  const data = Buffer.from(payload.base64, 'base64');
  if (data.length > MAX_IMAGE_BYTES) {
    throw new CdpError('CDP_PROTOCOL', '图片超过 20MB 上限');
  }
  return {
    data,
    mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : '',
    status: typeof payload.status === 'number' ? payload.status : 0,
  };
}

function rewritePageFetchError(error, url) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|fetch failed|networkerror/i.test(raw)) {
    return new CdpError('CDP_PROTOCOL', `页面内抓取图片失败（跨域或资源不可访问）：${url}`);
  }
  return error instanceof CdpError ? error : new CdpError('CDP_PROTOCOL', raw);
}

// 优先走 Chrome 网络栈；旧浏览器或不支持时再回退到页面 fetch。
async function fetchResourceInPage(options) {
  const url = String(options.url || '').trim();
  if (!url) {
    throw new CdpError('CDP_PROTOCOL', '缺少图片地址');
  }
  if (!isSafeCdpImageUrl(url)) {
    throw new CdpError('CDP_URL_BLOCKED', '拒绝抓取非公开或非 http(s) 图片地址');
  }

  return withPageSession(options, async session => {
    try {
      return await fetchViaChromeNetwork(session, url);
    } catch {
      // Network.loadNetworkResource 在旧 Chrome 上可能不存在；回退到页面 fetch。
    }

    const evaluate = async credentials => {
      const result = await session.sendCommand('Runtime.evaluate', {
        expression: pageFetchExpression(url, credentials),
        awaitPromise: true,
        returnByValue: true,
      });
      if (result && result.exceptionDetails) {
        const details = result.exceptionDetails;
        const pageError = (details.exception && (details.exception.description || details.exception.value))
          || details.text
          || '未知异常';
        throw new CdpError('CDP_PROTOCOL', `页面内抓取图片失败：${pageError}`);
      }
      return decodePageFetchPayload(result && result.result ? result.result.value : undefined);
    };

    try {
      return await evaluate('include');
    } catch {
      try {
        return await evaluate('omit');
      } catch (error) {
        throw rewritePageFetchError(error, url);
      }
    }
  });
}

// 打开新标签页：Chrome 111+ 起 /json/new 只接受 PUT，老版本只认 GET。先 PUT，
// 若返回 405/400（方法不被接受）再回退一次 GET。url 拼在 query 上，需整体编码。
async function openTarget(options) {
  const opts = normalizeOptions(options);
  const apiPath = `/json/new?${encodeURIComponent(String(options?.url || ''))}`;
  let response;
  try {
    response = await cdpHttpRequestWithRetry(opts, { method: 'PUT', apiPath });
    if (response.status === 405 || response.status === 400) {
      response = await cdpHttpRequestWithRetry(opts, { method: 'GET', apiPath });
    }
  } catch (error) {
    throw new CdpError('CDP_UNREACHABLE', `无法连接浏览器调试端口（${opts.host}:${opts.port}）：${error.message}`);
  }
  const target = await parseCdpJson(response, '/json/new');
  if (!target || typeof target.id !== 'string' || !target.id) {
    throw new CdpError('CDP_PROTOCOL', '浏览器调试接口 /json/new 返回格式异常');
  }
  return { id: target.id, url: target.url || '', title: target.title || '' };
}

module.exports = {
  CdpError,
  getCdpStatus,
  listPageTargets,
  evaluateInPage,
  capturePageScreenshot,
  fetchResourceInPage,
  openTarget,
  normalizeCdpHost,
  isSafeCdpImageUrl,
};
