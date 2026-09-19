const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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

async function startBackend(t, env = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gemini-aspect-'));
  const portProbe = http.createServer();
  const backendPort = await listen(portProbe);
  await close(portProbe);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(backendPort),
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_IMAGE_STREAM: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  child.stdout.on('data', chunk => { backendOutput += chunk; });
  child.stderr.on('data', chunk => { backendOutput += chunk; });
  t.after(async () => {
    await stopBackend(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });
  return { backendUrl, backendOutput: () => backendOutput };
}

async function waitTask(backendUrl, taskId, backendOutput) {
  return waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  }).then(task => {
    if (!task) throw new Error(backendOutput());
    return task;
  });
}

test('Antigravity Gemini auto layout infers 3:4 from 淘宝主图 prompt', async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const { backendUrl, backendOutput } = await startBackend(t);
  const response = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'openai',
      mode: 'text-to-image',
      prompt: '淘宝主图3:4',
      model: 'gemini-3.1-flash-image',
      parallelCount: 1,
      outputSize: 'auto',
      aspectRatio: 'auto',
    }),
  });
  assert.equal(response.status, 202);
  const { taskId } = await response.json();
  const task = await waitTask(backendUrl, taskId, backendOutput);
  assert.equal(task.status, 'completed', backendOutput());
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, '/v1/images/generations');
  assert.equal(upstreamRequests[0].body.aspect_ratio, '3:4');
  assert.equal(upstreamRequests[0].body.imageSize, '1K');
  assert.notEqual(upstreamRequests[0].body.aspect_ratio, 'auto');
});

test('native Gemini generateContent never sends auto aspect_ratio', async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('image').toString('base64') } }] },
      }],
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const { backendUrl, backendOutput } = await startBackend(t);
  const response = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'google',
      mode: 'text-to-image',
      prompt: '普通提示词',
      model: 'gemini-3.1-flash-image-preview',
      parallelCount: 1,
      outputSize: 'auto',
      aspectRatio: 'auto',
    }),
  });
  assert.equal(response.status, 202);
  const { taskId } = await response.json();
  const task = await waitTask(backendUrl, taskId, backendOutput);
  assert.equal(task.status, 'completed', backendOutput());
  assert.equal(upstreamRequests.length, 1);
  const imageConfig = upstreamRequests[0].body.generationConfig.imageConfig;
  assert.equal(imageConfig.aspectRatio, '1:1');
  assert.equal(imageConfig.imageSize, '1K');
});
