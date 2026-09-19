const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BACKEND_DIR = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}

async function findFreePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Timed out waiting for condition');
}

async function stopBackend(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

function startBackend(t, extraEnv = {}, prepare) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cdp-routes-'));
  const childEnv = {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
    NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
    NOVA_CDP_DIR: path.join(tempDir, 'cdp-products'),
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  prepare?.(tempDir);
  const child = spawn(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
    cwd: tempDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  child.stdout.on('data', chunk => { backendOutput += chunk; });
  child.stderr.on('data', chunk => { backendOutput += chunk; });
  t.after(async () => {
    await stopBackend(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { child, tempDir, getOutput: () => backendOutput };
}

async function waitBackendReady(child, backendUrl, getOutput) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${getOutput()}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });
}

function runLoopbackHelper(address) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cdp-helper-'));
  const script = `
    const { isLoopbackAddress } = require(${JSON.stringify(path.join(BACKEND_DIR, 'server.js'))});
    process.stdout.write('HELPER_RESULT=' + JSON.stringify(isLoopbackAddress(process.argv[1])));
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script, address], {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: '0',
        HOSTNAME: '127.0.0.1',
        NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
        NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
        NOVA_CDP_DIR: path.join(tempDir, 'cdp-products'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const match = result.stdout.match(/HELPER_RESULT=(true|false)/);
    assert.ok(match, `helper output missing: ${result.stdout}`);
    return match[1] === 'true';
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('cdp 启动清理删除过期 gif 商品素材', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, tempDir, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
  }, dir => {
    const cdpDir = path.join(dir, 'cdp-products');
    fs.mkdirSync(cdpDir, { recursive: true });
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const gifPath = path.join(cdpDir, 'expired.gif');
    fs.writeFileSync(gifPath, 'gif');
    fs.utimesSync(gifPath, oldTime, oldTime);
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  assert.equal(fs.existsSync(path.join(tempDir, 'cdp-products', 'expired.gif')), false);
});

test('cdp 路由：gif 商品素材返回 image/gif', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
  }, dir => {
    const cdpDir = path.join(dir, 'cdp-products');
    fs.mkdirSync(cdpDir, { recursive: true });
    fs.writeFileSync(path.join(cdpDir, 'fresh.gif'), 'gif');
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const response = await fetch(`${backendUrl}/api/nova/cdp/products/fresh.gif`);
  assert.equal(response.status, 200, getOutput());
  assert.equal(response.headers.get('content-type'), 'image/gif');
});

test('cdp 配置显式记录非回环 NOVA_CDP_HOST 被限制为回环地址', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
    NOVA_CDP_HOST: '192.168.1.5',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const response = await fetch(`${backendUrl}/api/nova/cdp/config`);
  assert.equal(response.status, 200, getOutput());
  const body = await response.json();
  assert.equal(body.host, '127.0.0.1');
  assert.match(getOutput(), /NOVA_CDP_HOST.*127\.0\.0\.1/);
});

test('cdp 路由：未显式开启时默认关闭', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: undefined,
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const statusResponse = await fetch(`${backendUrl}/api/nova/cdp/status`);
  assert.equal(statusResponse.status, 404, getOutput());
});

test('cdp 来源判断只允许 loopback 地址', () => {
  assert.equal(runLoopbackHelper('127.0.0.1'), true);
  assert.equal(runLoopbackHelper('::1'), true);
  assert.equal(runLoopbackHelper('::ffff:127.0.0.1'), true);
  assert.equal(runLoopbackHelper('0:0:0:0:0:ffff:7f00:1'), true);
  assert.equal(runLoopbackHelper('192.168.1.2'), false);
});

test('cdp 路由：伪造 XFF 的 loopback 请求没有 token 时返回 403', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
    NOVA_CDP_TOKEN: undefined,
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const response = await fetch(`${backendUrl}/api/nova/cdp/status`, {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(response.status, 403, getOutput());
  const body = await response.json();
  assert.equal(body.code, 'CDP_AUTH_REQUIRED');
});

test('cdp 路由：正确 token 可通过带 XFF 的 loopback 请求', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
    NOVA_CDP_TOKEN: 'test-cdp-token',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const response = await fetch(`${backendUrl}/api/nova/cdp/status`, {
    headers: {
      'x-forwarded-for': '203.0.113.10',
      'x-nova-cdp-token': 'test-cdp-token',
    },
  });
  assert.equal(response.status, 200, getOutput());
  const body = await response.json();
  assert.equal(body.reachable, false);
  assert.doesNotMatch(JSON.stringify(body), /test-cdp-token/);
});

test('cdp 路由：浏览器不在线时的基本行为', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  // 指向一个未占用端口，模拟本机没有可调式的浏览器
  const fakeCdpPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(fakeCdpPort),
    NOVA_CDP_ENABLED: 'true',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  // a) GET status：浏览器不可达时仍返回 200 且 reachable === false。
  // 没有反向代理头时，真实 loopback 请求允许访问。
  const statusResponse = await fetch(`${backendUrl}/api/nova/cdp/status`);
  assert.equal(statusResponse.status, 200, getOutput());
  const statusBody = await statusResponse.json();
  assert.equal(statusBody.reachable, false);

  // b) POST extract 缺 targetId → 400
  const extractResponse = await fetch(`${backendUrl}/api/nova/cdp/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(extractResponse.status, 400);
  const extractBody = await extractResponse.json();
  assert.equal(extractBody.code, 'INVALID_PARAMS');

  // c) POST evaluate：NOVA_CDP_EVAL_ENABLED 默认 false → 403
  const evaluateResponse = await fetch(`${backendUrl}/api/nova/cdp/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: 'abc', expression: '1+1' }),
  });
  assert.equal(evaluateResponse.status, 403);
  const evaluateBody = await evaluateResponse.json();
  assert.equal(evaluateBody.code, 'CDP_EVAL_DISABLED');

  // d) 商品素材静态服务防路径穿越 → 400 或 404
  const traverseResponse = await fetch(`${backendUrl}/api/nova/cdp/products/..%2F..%2Fetc`);
  assert.ok([400, 404].includes(traverseResponse.status), `预期 400/404，实际 ${traverseResponse.status}`);

  // e) POST open 缺 url → 400
  const openMissingResponse = await fetch(`${backendUrl}/api/nova/cdp/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(openMissingResponse.status, 400);
  const openMissingBody = await openMissingResponse.json();
  assert.equal(openMissingBody.code, 'INVALID_PARAMS');

  // f) POST open url 为 javascript: 协议 → 400
  const openJsResponse = await fetch(`${backendUrl}/api/nova/cdp/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'javascript:alert(1)' }),
  });
  assert.equal(openJsResponse.status, 400);
  const openJsBody = await openJsResponse.json();
  assert.equal(openJsBody.code, 'INVALID_PARAMS');

  // g) POST read-page 缺 targetId → 400
  const readPageResponse = await fetch(`${backendUrl}/api/nova/cdp/read-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(readPageResponse.status, 400);
  const readPageBody = await readPageResponse.json();
  assert.equal(readPageBody.code, 'INVALID_PARAMS');

  // h) GET status 即使不可达也返回当前配置端口
  assert.equal(statusBody.port, fakeCdpPort);

  // i) POST config 缺 port → 400
  const configMissing = await fetch(`${backendUrl}/api/nova/cdp/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(configMissing.status, 400);

  // j) POST config 切换端口后 status 跟着变
  const nextPort = await findFreePort();
  const configResponse = await fetch(`${backendUrl}/api/nova/cdp/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: nextPort }),
  });
  assert.equal(configResponse.status, 200);
  const configBody = await configResponse.json();
  assert.equal(configBody.port, nextPort);
  assert.equal(configBody.reachable, false);

  // k) 浏览器不可达时 open 返回原文，不能被改写成「网络连接失败」
  const openFail = await fetch(`${backendUrl}/api/nova/cdp/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(openFail.status, 502);
  const openFailBody = await openFail.json();
  assert.equal(openFailBody.code, 'CDP_UNREACHABLE');
  assert.match(String(openFailBody.error), /无法连接浏览器调试端口/);
  assert.doesNotMatch(String(openFailBody.error), /网络连接失败/);
});

test('cdp 路由：NOVA_CDP_ENABLED=false 时全部 404', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const fakeCdpPort = await findFreePort();
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(fakeCdpPort),
    NOVA_CDP_ENABLED: 'false',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const statusResponse = await fetch(`${backendUrl}/api/nova/cdp/status`);
  assert.equal(statusResponse.status, 404);
});

async function waitHttpReady(port, timeoutMs = 3000) {
  await waitFor(async () => {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 400, family: 4 }, res => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.on('error', reject);
    });
    return true;
  }, timeoutMs);
}

async function startHttpStub(t, handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  await waitHttpReady(port);
  t.after(() => close(server));
  return { port, server };
}

function startFakeCdp(t, version = {
  Browser: 'Chrome/131.0.6778.140',
  'Protocol-Version': '1.3',
}, targets = []) {
  const requests = [];
  return startHttpStub(t, (req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(version));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not chrome');
  }).then(result => ({ ...result, requests }));
}

function startPlainHttpStub(t) {
  return startHttpStub(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('hello from ordinary service');
  });
}

function createFakeChrome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fake-chrome-'));
  const markerPath = path.join(dir, 'spawned');
  const executable = path.join(dir, 'fake-chrome');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "spawned %s\\n" "$*" > "$NOVA_SPAWN_MARKER"\n');
  fs.chmodSync(executable, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { executable, markerPath };
}

test('cdp 路由：open 复用同 URL 的现有标签页', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const pageUrl = 'https://example.com/existing';
  const fakeCdp = await startFakeCdp(t, undefined, [{
    id: 'existing-tab',
    type: 'page',
    title: 'Example',
    url: pageUrl,
  }]);
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(fakeCdp.port),
    NOVA_CDP_ENABLED: 'true',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const response = await fetch(`${backendUrl}/api/nova/cdp/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: pageUrl }),
  });

  assert.equal(response.status, 200, getOutput());
  assert.deepEqual(await response.json(), { targetId: 'existing-tab', url: pageUrl, reused: true });
  assert.equal(fakeCdp.requests.includes('/json/new'), false);
});

test('cdp 路由：config 允许接入已被有效 CDP 占用的端口', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const idlePort = await findFreePort();
  const fakeCdp = await startFakeCdp(t);
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(idlePort),
    NOVA_CDP_ENABLED: 'true',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const configResponse = await fetch(`${backendUrl}/api/nova/cdp/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: fakeCdp.port }),
  });
  assert.equal(configResponse.status, 200, getOutput());
  const configBody = await configResponse.json();
  assert.equal(configBody.port, fakeCdp.port);
  assert.equal(configBody.reachable, true);
  assert.match(String(configBody.browser || ''), /Chrome/);

  const statusResponse = await fetch(`${backendUrl}/api/nova/cdp/status`);
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json();
  assert.equal(statusBody.port, fakeCdp.port);
  assert.equal(statusBody.reachable, true);
});

test('cdp 路由：config 拒绝被普通 HTTP 服务占用的端口', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const idlePort = await findFreePort();
  const ordinary = await startPlainHttpStub(t);
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(idlePort),
    NOVA_CDP_ENABLED: 'true',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const configResponse = await fetch(`${backendUrl}/api/nova/cdp/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: ordinary.port }),
  });
  assert.equal(configResponse.status, 409, getOutput());
  const configBody = await configResponse.json();
  assert.equal(configBody.code, 'PORT_IN_USE');

  const statusResponse = await fetch(`${backendUrl}/api/nova/cdp/status`);
  const statusBody = await statusResponse.json();
  assert.equal(statusBody.port, idlePort);
});

test('cdp 路由：config 在环境变量已指向有效 CDP 端口时允许保存', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const fakeCdp = await startFakeCdp(t);
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(fakeCdp.port),
    NOVA_CDP_ENABLED: 'true',
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const configResponse = await fetch(`${backendUrl}/api/nova/cdp/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: fakeCdp.port }),
  });
  assert.equal(configResponse.status, 200, getOutput());
  const configBody = await configResponse.json();
  assert.equal(configBody.port, fakeCdp.port);
  assert.equal(configBody.reachable, true);
  assert.match(String(configBody.browser || ''), /Chrome/);
});

test('cdp 路由：launch 对已有有效 CDP 复用且不 spawn', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const fakeCdp = await startFakeCdp(t);
  const fakeChrome = createFakeChrome(t);
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(fakeCdp.port),
    NOVA_CDP_ENABLED: 'true',
    NOVA_CHROME_PATH: fakeChrome.executable,
    NOVA_SPAWN_MARKER: fakeChrome.markerPath,
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const launchResponse = await fetch(`${backendUrl}/api/nova/cdp/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(launchResponse.status, 200, getOutput());
  const launchBody = await launchResponse.json();
  assert.equal(launchBody.ok, true);
  assert.equal(launchBody.port, fakeCdp.port);
  assert.match(String(launchBody.message || ''), /已连接|现有|复用|已有/);
  assert.equal(fs.existsSync(fakeChrome.markerPath), false, `不应 spawn 浏览器：${getOutput()}`);
});

test('cdp 路由：launch 对非 CDP 占用端口返回 PORT_IN_USE 且不 spawn', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const ordinary = await startPlainHttpStub(t);
  const fakeChrome = createFakeChrome(t);
  const { child, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_PORT: String(ordinary.port),
    NOVA_CDP_ENABLED: 'true',
    NOVA_CHROME_PATH: fakeChrome.executable,
    NOVA_SPAWN_MARKER: fakeChrome.markerPath,
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const launchResponse = await fetch(`${backendUrl}/api/nova/cdp/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(launchResponse.status, 409, getOutput());
  const launchBody = await launchResponse.json();
  assert.equal(launchBody.code, 'PORT_IN_USE');
  assert.equal(fs.existsSync(fakeChrome.markerPath), false, `不应 spawn 浏览器：${getOutput()}`);
});

test('cdp 路由：fetch-image 对已抓过的 URL 直接复用落盘文件，不访问浏览器', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, tempDir, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
    NOVA_CDP_PORT: '1', // 无浏览器：复用生效时全程不应访问调试端口
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const imageUrl = 'https://img.alicdn.com/imgextra/i1/4097062355/test-photo.png';
  const urlHash = require('node:crypto').createHash('sha1').update(imageUrl).digest('hex').slice(0, 16);
  const cdpDir = path.join(tempDir, 'cdp-products');
  fs.mkdirSync(cdpDir, { recursive: true });
  const seeded = `p_${urlHash}_123.jpg`;
  fs.writeFileSync(path.join(cdpDir, seeded), Buffer.from('fake-jpeg'));

  const response = await fetch(`${backendUrl}/api/nova/cdp/fetch-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: 'irrelevant', url: imageUrl }),
  });
  assert.equal(response.status, 200, getOutput());
  const payload = await response.json();
  assert.equal(payload.localUrl, `/api/nova/cdp/products/${seeded}`);
  assert.deepEqual(fs.readdirSync(cdpDir), [seeded], '复用不得产生新文件');
});

test('cdp 路由：purge-images 只删除 CDP 目录内合法文件名', { timeout: 60000 }, async t => {
  const backendPort = await findFreePort();
  const { child, tempDir, getOutput } = startBackend(t, {
    PORT: String(backendPort),
    NOVA_CDP_ENABLED: 'true',
  }, dir => {
    const cdpDir = path.join(dir, 'cdp-products');
    fs.mkdirSync(cdpDir, { recursive: true });
    fs.writeFileSync(path.join(cdpDir, 'p_aaaaaaaaaaaaaaaa_1.jpg'), 'keep-me-not');
    fs.writeFileSync(path.join(cdpDir, 'p_bbbbbbbbbbbbbbbb_2.png'), 'keep');
    fs.writeFileSync(path.join(cdpDir, 'outside.txt'), 'nope');
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitBackendReady(child, backendUrl, getOutput);

  const response = await fetch(`${backendUrl}/api/nova/cdp/purge-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        '/api/nova/cdp/products/p_aaaaaaaaaaaaaaaa_1.jpg',
        '../outside.txt',
        'p_bbbbbbbbbbbbbbbb_2.png',
      ],
    }),
  });
  assert.equal(response.status, 200, getOutput());
  const payload = await response.json();
  assert.equal(payload.deleted, 2, getOutput());
  const cdpDir = path.join(tempDir, 'cdp-products');
  assert.equal(fs.existsSync(path.join(cdpDir, 'p_aaaaaaaaaaaaaaaa_1.jpg')), false);
  assert.equal(fs.existsSync(path.join(cdpDir, 'p_bbbbbbbbbbbbbbbb_2.png')), false);
  assert.equal(fs.existsSync(path.join(cdpDir, 'outside.txt')), true);
});
