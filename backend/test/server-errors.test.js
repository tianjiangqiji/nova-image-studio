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

async function startBackend(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-server-errors-'));
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

async function waitTask(backendUrl, taskId) {
  return waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  });
}

test('DashScope 200 {code,message} surfaces the message', async t => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'InvalidParameter', message: 'size is invalid' }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const { backendUrl, backendOutput } = await startBackend(t);
  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'alibaba-dashscope',
      mode: 'text-to-image',
      prompt: 'a cat',
      model: 'qwen-image-plus',
      parallelCount: 1,
      outputSize: '1K',
      aspectRatio: '1:1',
      images: [],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();
  const task = await waitTask(backendUrl, taskId);

  assert.equal(task.status, 'failed', backendOutput());
  assert.match(task.error, /size is invalid/);
});

test('Gemini no-image response includes blockReason and finishReason', async t => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: [{ finishReason: 'IMAGE_OTHER', content: { parts: [{ text: 'blocked' }] } }],
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const { backendUrl, backendOutput } = await startBackend(t);
  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'google',
      mode: 'text-to-image',
      prompt: 'a landscape',
      model: 'gemini-3.1-flash-image-preview',
      parallelCount: 1,
      outputSize: '1K',
      aspectRatio: '1:1',
      images: [],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();
  const task = await waitTask(backendUrl, taskId);

  assert.equal(task.status, 'failed', backendOutput());
  assert.match(task.error, /响应中无图片数据/);
  assert.match(task.error, /SAFETY/);
  assert.match(task.error, /IMAGE_OTHER/);
});

test('Gemini image-to-image defaults missing mimeType and accepts missing images array', async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ inlineData: { data: Buffer.from('image').toString('base64'), mimeType: 'image/png' } }],
        },
      }],
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const { backendUrl, backendOutput } = await startBackend(t);
  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'google',
      mode: 'image-to-image',
      prompt: 'edit the image',
      model: 'gemini-3.1-flash-image-preview',
      parallelCount: 1,
      outputSize: '1K',
      aspectRatio: '1:1',
      images: [{ data: Buffer.from('ref-image').toString('base64') }],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();
  const task = await waitTask(backendUrl, taskId);

  assert.equal(task.status, 'completed', backendOutput());
  assert.equal(upstreamRequests.length, 1);
  const parts = upstreamRequests[0].contents[0].parts;
  assert.equal(parts[0].text, 'edit the image');
  assert.equal(parts[1].inlineData.mimeType, 'image/png');
  assert.ok(parts[1].inlineData.data);
});
