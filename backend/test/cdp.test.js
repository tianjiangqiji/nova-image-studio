const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const {
  CdpError,
  getCdpStatus,
  listPageTargets,
  evaluateInPage,
  fetchResourceInPage,
  openTarget,
  normalizeCdpHost,
  isSafeCdpImageUrl,
} = require('../cdp');

// 本机带有透明代理（NODE_USE_ENV_PROXY=1），刚 listen 的 loopback 端口第一个 TCP
// 连接会被拒绝（ECONNREFUSED），后续连接正常；listen 后先预热重试，等端口真正可连
// 再交给测试，与 image-stream 集成测试里 waitFor 轮询的应对方式同理。
async function waitPortReady(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error('Timed out waiting for port');
}

async function listen(server) {
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  await waitPortReady(port);
  return port;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}

// 模拟 Chrome DevTools 端点：/json/version 与 /json/list 走 HTTP，页面
// WebSocket 按收到的命令 id 回对应响应；onCommand 返回 null 表示故意不应答
// （用于复现超时路径）。
async function startFakeChrome({ version, targets, onCommand, rejectFirstUpgrade = false }) {
  const receivedCommands = [];
  let rejectedUpgrades = 0;
  const wsServer = new WebSocketServer({ noServer: true });
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(version));
      return;
    }
    if (req.url === '/json/list') {
      const port = httpServer.address().port;
      const list = targets.map(target => ({
        ...target,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if (rejectFirstUpgrade && rejectedUpgrades === 0) {
      rejectedUpgrades += 1;
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        const command = JSON.parse(raw.toString());
        receivedCommands.push(command);
        const outcome = onCommand(command);
        if (outcome === null) return; // 不应答，客户端应走超时路径
        const response = { id: command.id };
        if (outcome.error) {
          response.error = outcome.error;
        } else {
          response.result = outcome.result || {};
        }
        ws.send(JSON.stringify(response));
      });
    });
  });

  const port = await listen(httpServer);

  async function stop() {
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(resolve));
    await close(httpServer);
  }

  return { port, receivedCommands, stop };
}

const VERSION_INFO = {
  Browser: 'Chrome/131.0.6778.140',
  'Protocol-Version': '1.3',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0',
  'V8-Version': '13.1.201',
  'WebKit-Version': '537.36 (@cf1841e0ecdfda68b82134cbdc17c8e1b8ee64fb)',
};

const PAGE_TARGETS = [
  { id: 'page-1', type: 'page', title: '淘宝网 - 淘！我喜欢', url: 'https://www.taobao.com/' },
  { id: 'page-2', type: 'page', title: '商品详情', url: 'https://item.taobao.com/item.htm?id=12345' },
  { id: 'worker-1', type: 'service_worker', title: 'Service Worker', url: 'https://www.taobao.com/sw.js' },
  { id: 'bg-1', type: 'background_page', title: '扩展后台页', url: 'chrome-extension://abc/bg.html' },
];

test('CDP host 配置拒绝非 loopback 并接受 loopback 变体', () => {
  assert.equal(normalizeCdpHost('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeCdpHost('localhost'), 'localhost');
  assert.equal(normalizeCdpHost('::1'), '::1');
  assert.equal(normalizeCdpHost('::ffff:127.0.0.1'), '::ffff:127.0.0.1');
  assert.equal(normalizeCdpHost('192.168.1.10'), '127.0.0.1');
  assert.equal(normalizeCdpHost('example.com'), '127.0.0.1');
});

test('CDP 图片 URL 只允许公开 http/https 地址', () => {
  assert.equal(isSafeCdpImageUrl('https://img.example.com/image.png'), true);
  assert.equal(isSafeCdpImageUrl('http://8.8.8.8/image.png'), true);
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://localhost/image.png',
    'http://127.0.0.1/image.png',
    'http://10.0.0.8/image.png',
    'http://172.16.0.4/image.png',
    'http://192.168.1.8/image.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/image.png',
    'http://[fd00::1]/image.png',
    'http://metadata.google.internal/image.png',
  ]) {
    assert.equal(isSafeCdpImageUrl(url), false, url);
  }
});

test('fetchResourceInPage 在连接浏览器前拒绝内部图片地址', async () => {
  await assert.rejects(
    fetchResourceInPage({
      host: '127.0.0.1',
      port: 1,
      targetId: 'page-1',
      url: 'http://169.254.169.254/latest/meta-data/',
      timeoutMs: 100,
    }),
    error => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, 'CDP_URL_BLOCKED');
      return true;
    },
  );
});

test('getCdpStatus 在浏览器可达时返回 reachable:true 和版本信息', async t => {
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: [],
    onCommand: () => ({ result: {} }),
  });
  t.after(chrome.stop);

  const status = await getCdpStatus({ host: '127.0.0.1', port: chrome.port, timeoutMs: 1000 });
  assert.deepEqual(status, {
    reachable: true,
    browser: 'Chrome/131.0.6778.140',
    version: '1.3',
  });
});

test('getCdpStatus 在端口不可达时返回 reachable:false 且不抛错', async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);

  const status = await getCdpStatus({ host: '127.0.0.1', port, timeoutMs: 500 });
  assert.deepEqual(status, { reachable: false, host: '127.0.0.1', port });
});

test('getCdpStatus 在接口返回异常状态时返回 reachable:false 且不抛错', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  t.after(() => close(server));

  const status = await getCdpStatus({ host: '127.0.0.1', port, timeoutMs: 1000 });
  assert.deepEqual(status, { reachable: false, host: '127.0.0.1', port });
});

test('listPageTargets 只保留 page 类型的标签页', async t => {
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: () => ({ result: {} }),
  });
  t.after(chrome.stop);

  const targets = await listPageTargets({ host: '127.0.0.1', port: chrome.port, timeoutMs: 1000 });
  assert.deepEqual(targets, [
    { id: 'page-1', title: '淘宝网 - 淘！我喜欢', url: 'https://www.taobao.com/' },
    { id: 'page-2', title: '商品详情', url: 'https://item.taobao.com/item.htm?id=12345' },
  ]);
});

test('evaluateInPage 返回页面内表达式的求值结果', async t => {
  const product = { platform: 'taobao', title: '测试商品', price: '9.90', mainImages: ['https://img.example.com/1.jpg'] };
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: command => {
      if (command.method !== 'Runtime.evaluate') return { result: {} };
      return { result: { result: { type: 'object', value: product } } };
    },
  });
  t.after(chrome.stop);

  const value = await evaluateInPage({
    host: '127.0.0.1',
    port: chrome.port,
    targetId: 'page-1',
    expression: 'window.__extractProduct()',
    timeoutMs: 1000,
  });
  assert.deepEqual(value, product);

  assert.equal(chrome.receivedCommands.length, 1);
  const command = chrome.receivedCommands[0];
  assert.equal(command.method, 'Runtime.evaluate');
  assert.equal(command.params.expression, 'window.__extractProduct()');
  assert.equal(command.params.awaitPromise, true);
  assert.equal(command.params.returnByValue, true);
});

test('evaluateInPage 在 WebSocket 首次被拒绝后重试并完成求值', async t => {
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    rejectFirstUpgrade: true,
    onCommand: command => command.method === 'Runtime.evaluate'
      ? { result: { result: { type: 'number', value: 2 } } }
      : { result: {} },
  });
  t.after(chrome.stop);

  const value = await evaluateInPage({
    host: '127.0.0.1',
    port: chrome.port,
    targetId: 'page-1',
    expression: '1 + 1',
    timeoutMs: 1000,
  });
  assert.equal(value, 2);
});

test('fetchResourceInPage 优先走 Chrome 网络栈，不依赖页面 fetch', async t => {
  const imageBytes = Buffer.from('network-webp');
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: command => {
      if (command.method === 'Page.enable' || command.method === 'Network.enable') {
        return { result: {} };
      }
      if (command.method === 'Page.getFrameTree') {
        return { result: { frameTree: { frame: { id: 'frame-main', url: 'https://item.taobao.com/item.htm' } } } };
      }
      if (command.method === 'Network.loadNetworkResource') {
        assert.equal(command.params.url, 'https://img.alicdn.com/example.webp');
        assert.equal(command.params.frameId, 'frame-main');
        return {
          result: {
            resource: {
              success: true,
              httpStatusCode: 200,
              stream: 'stream-1',
              headers: { 'content-type': 'image/webp' },
            },
          },
        };
      }
      if (command.method === 'IO.read') {
        assert.equal(command.params.handle, 'stream-1');
        return { result: { data: imageBytes.toString('base64'), base64Encoded: true, eof: true } };
      }
      if (command.method === 'IO.close') {
        return { result: {} };
      }
      if (command.method === 'Runtime.evaluate') {
        throw new Error('不应再回退到页面 fetch');
      }
      return { result: {} };
    },
  });
  t.after(chrome.stop);

  const resource = await fetchResourceInPage({
    host: '127.0.0.1',
    port: chrome.port,
    targetId: 'page-1',
    url: 'https://img.alicdn.com/example.webp',
    timeoutMs: 1000,
  });

  assert.deepEqual(resource, {
    data: imageBytes,
    mimeType: 'image/webp',
    status: 200,
  });
  assert.ok(chrome.receivedCommands.some(item => item.method === 'Network.loadNetworkResource'));
  assert.equal(chrome.receivedCommands.some(item => item.method === 'Runtime.evaluate'), false);
});

test('fetchResourceInPage 在带凭据请求触发 CORS 时回退为无凭据请求', async t => {
  const imageBytes = Buffer.from('fake-webp').toString('base64');
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: command => {
      if (command.method !== 'Runtime.evaluate') return { result: {} };
      const expression = command.params.expression;
      if (expression.includes("credentials: 'include'")) {
        return {
          result: {
            result: { type: 'object', subtype: 'error', description: 'TypeError: Failed to fetch' },
            exceptionDetails: {
              text: 'Uncaught (in promise)',
              exception: { className: 'TypeError', description: 'TypeError: Failed to fetch' },
            },
          },
        };
      }
      assert.match(expression, /credentials: 'omit'/);
      return {
        result: {
          result: {
            type: 'object',
            value: { base64: imageBytes, mimeType: 'image/webp', status: 200 },
          },
        },
      };
    },
  });
  t.after(chrome.stop);

  const resource = await fetchResourceInPage({
    host: '127.0.0.1',
    port: chrome.port,
    targetId: 'page-1',
    url: 'https://img.alicdn.com/example.webp',
    timeoutMs: 1000,
  });

  assert.deepEqual(resource, {
    data: Buffer.from('fake-webp'),
    mimeType: 'image/webp',
    status: 200,
  });
  const evals = chrome.receivedCommands.filter(item => item.method === 'Runtime.evaluate');
  assert.equal(evals.length, 2);
  assert.match(evals[0].params.expression, /credentials: 'include'/);
  assert.match(evals[1].params.expression, /credentials: 'omit'/);
});

test('evaluateInPage 在页面抛异常时抛出 CDP_PROTOCOL 错误并带页面异常文本', async t => {
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: () => ({
      result: {
        result: { type: 'object', subtype: 'error', description: 'ReferenceError: foo is not defined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { className: 'ReferenceError', description: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1' },
        },
      },
    }),
  });
  t.after(chrome.stop);

  await assert.rejects(
    evaluateInPage({
      host: '127.0.0.1',
      port: chrome.port,
      targetId: 'page-1',
      expression: 'foo()',
      timeoutMs: 1000,
    }),
    error => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, 'CDP_PROTOCOL');
      assert.match(error.message, /foo is not defined/);
      return true;
    },
  );
});

test('evaluateInPage 在浏览器不应答时抛出 CDP_TIMEOUT 错误', async t => {
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: () => null, // 故意不应答
  });
  t.after(chrome.stop);

  await assert.rejects(
    evaluateInPage({
      host: '127.0.0.1',
      port: chrome.port,
      targetId: 'page-1',
      expression: '1 + 1',
      timeoutMs: 200,
    }),
    error => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, 'CDP_TIMEOUT');
      return true;
    },
  );
});

test('evaluateInPage 在 targetId 不存在时抛出 CDP_TARGET_NOT_FOUND 错误', async t => {
  const chrome = await startFakeChrome({
    version: VERSION_INFO,
    targets: PAGE_TARGETS,
    onCommand: () => ({ result: {} }),
  });
  t.after(chrome.stop);

  await assert.rejects(
    evaluateInPage({
      host: '127.0.0.1',
      port: chrome.port,
      targetId: 'not-exists',
      expression: '1 + 1',
      timeoutMs: 1000,
    }),
    error => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, 'CDP_TARGET_NOT_FOUND');
      return true;
    },
  );
});

test('openTarget 以 PUT 调 /json/new，url 拼在 query 且整体编码', async t => {
  const receivedRequests = [];
  const server = http.createServer((req, res) => {
    receivedRequests.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'new-page-1', url: 'https://example.com/?a=1&b=2', title: 'Example' }));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const pageUrl = 'https://example.com/?a=1&b=2';
  const target = await openTarget({ host: '127.0.0.1', port, url: pageUrl, timeoutMs: 1000 });
  assert.deepEqual(target, { id: 'new-page-1', url: pageUrl, title: 'Example' });

  assert.equal(receivedRequests.length, 1);
  assert.equal(receivedRequests[0].method, 'PUT');
  assert.equal(receivedRequests[0].url, `/json/new?${encodeURIComponent(pageUrl)}`);
});

test('openTarget 在 PUT 返回 405 时回退 GET 再试一次', async t => {
  const receivedRequests = [];
  const server = http.createServer((req, res) => {
    receivedRequests.push({ method: req.method, url: req.url });
    if (req.method === 'PUT') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'new-page-2', url: 'https://example.com/', title: '' }));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const target = await openTarget({ host: '127.0.0.1', port, url: 'https://example.com/', timeoutMs: 1000 });
  assert.equal(target.id, 'new-page-2');
  assert.deepEqual(receivedRequests.map(item => item.method), ['PUT', 'GET']);
});

test('openTarget 在浏览器不可达时抛出 CDP_UNREACHABLE 错误', async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);

  await assert.rejects(
    openTarget({ host: '127.0.0.1', port, url: 'https://example.com/', timeoutMs: 500 }),
    error => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, 'CDP_UNREACHABLE');
      return true;
    },
  );
});

test('openTarget 在接口返回异常状态时抛出 CDP_PROTOCOL 错误', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  t.after(() => close(server));

  await assert.rejects(
    openTarget({ host: '127.0.0.1', port, url: 'https://example.com/', timeoutMs: 1000 }),
    error => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, 'CDP_PROTOCOL');
      return true;
    },
  );
});

test('listPageTargets 在 /json/list 404 时回退到 /json（360ChromeX 等精简分支）', async t => {
  // 模拟只提供 /json 的精简 Chromium 分支
  const server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(PAGE_TARGETS));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  t.after(() => close(server));

  const targets = await listPageTargets({ host: '127.0.0.1', port, timeoutMs: 1000 });
  assert.deepEqual(targets, [
    { id: 'page-1', title: '淘宝网 - 淘！我喜欢', url: 'https://www.taobao.com/' },
    { id: 'page-2', title: '商品详情', url: 'https://item.taobao.com/item.htm?id=12345' },
  ]);
});
