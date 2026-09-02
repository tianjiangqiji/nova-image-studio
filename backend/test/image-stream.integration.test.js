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

test('retries an unsupported partial-images request without stream parameters', async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamRequests.push(body);

    if (body.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unsupported parameter: partial_images' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }));
  });
  const upstreamPort = await listen(upstream);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-stream-'));

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
      NOVA_IMAGE_PARTIAL_IMAGES: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  child.stdout.on('data', chunk => { backendOutput += chunk; });
  child.stderr.on('data', chunk => { backendOutput += chunk; });
  t.after(async () => {
    await stopBackend(child);
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });

  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'openai',
      mode: 'text-to-image',
      prompt: 'test image',
      model: 'gpt-image-1',
      parallelCount: 1,
      outputSize: 'auto',
      aspectRatio: 'auto',
      images: [],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  });

  assert.equal(task.status, 'completed', backendOutput);
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[0].stream, true);
  assert.equal(upstreamRequests[0].partial_images, 2);
  assert.equal('stream' in upstreamRequests[1], false);
  assert.equal('partial_images' in upstreamRequests[1], false);
});

test('Gemini imageConfig defaults auto values and preserves an explicit aspect ratio', async t => {
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gemini-image-'));
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
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });

  async function createGeminiTask(outputSize, aspectRatio, prompt = '淘宝主图3:4') {
    const response = await fetch(`${backendUrl}/api/nova/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        protocol: 'google',
        mode: 'text-to-image',
        prompt,
        model: 'gemini-3.1-flash-image-preview',
        parallelCount: 1,
        outputSize,
        aspectRatio,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();
    const task = await waitFor(async () => {
      const taskResponse = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
      const value = await taskResponse.json();
      return ['completed', 'failed'].includes(value.status) ? value : null;
    });
    assert.equal(task.status, 'completed', backendOutput);
  }

  await createGeminiTask('auto', 'auto', '普通提示词');
  await createGeminiTask('1K', '3:4');
  await createGeminiTask('1K', '');
  await createGeminiTask('weird', '9:16-invalid');
  await createGeminiTask('1K', '1:8');
  await createGeminiTask('512', '1:1');

  assert.equal(upstreamRequests.length, 6);
  assert.deepEqual(upstreamRequests[0].generationConfig.imageConfig, {
    imageSize: '1K',
    aspectRatio: '1:1',
  });
  assert.deepEqual(upstreamRequests[1].generationConfig.imageConfig, {
    imageSize: '1K',
    aspectRatio: '3:4',
  });
  assert.deepEqual(upstreamRequests[2].generationConfig.imageConfig, {
    imageSize: '1K',
    aspectRatio: '3:4',
  });
  assert.deepEqual(upstreamRequests[3].generationConfig.imageConfig, {
    imageSize: '1K',
    aspectRatio: '3:4',
  });
  assert.deepEqual(upstreamRequests[4].generationConfig.imageConfig, {
    imageSize: '1K',
    aspectRatio: '1:8',
  });
  assert.deepEqual(upstreamRequests[5].generationConfig.imageConfig, {
    imageSize: '1K',
    aspectRatio: '1:1',
  });
});

test('Gemini upstream 504 openresty HTML becomes a short gateway timeout error', async t => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(504, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>openresty</center></body></html>');
  });
  const upstreamPort = await listen(upstream);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gemini-504-'));
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
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });

  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'google',
      mode: 'text-to-image',
      prompt: '淘宝主图3:4',
      model: 'gemini-3.1-flash-image-preview',
      parallelCount: 1,
      outputSize: '1K',
      aspectRatio: '3:4',
      images: [],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  });

  assert.equal(task.status, 'failed', backendOutput);
  assert.match(task.error, /上游网关超时|Gateway Time-out|504/);
  assert.doesNotMatch(task.error, /<!DOCTYPE|<html|<center>|openresty/i);
});

test('OpenAI protocol Gemini models map Antigravity size/quality without stream params', async t => {
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-antigravity-gemini-'));
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
      NOVA_IMAGE_STREAM: 'true',
      NOVA_IMAGE_PARTIAL_IMAGES: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  child.stdout.on('data', chunk => { backendOutput += chunk; });
  child.stderr.on('data', chunk => { backendOutput += chunk; });
  t.after(async () => {
    await stopBackend(child);
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });

  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'openai',
      mode: 'text-to-image',
      prompt: '淘宝主图3:4',
      model: 'gemini-3-pro-image-preview',
      parallelCount: 1,
      outputSize: '4K',
      aspectRatio: '3:4',
      images: [],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  });

  assert.equal(task.status, 'completed', backendOutput);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, '/v1/images/generations');
  assert.equal(upstreamRequests[0].body.size, '3:4');
  assert.equal(upstreamRequests[0].body.aspect_ratio, '3:4');
  assert.equal(upstreamRequests[0].body.quality, 'hd');
  assert.equal(upstreamRequests[0].body.imageSize, '4K');
  assert.equal('stream' in upstreamRequests[0].body, false);
  assert.equal('partial_images' in upstreamRequests[0].body, false);
  assert.equal('background' in upstreamRequests[0].body, false);
  assert.equal('style' in upstreamRequests[0].body, false);
});

test('OpenAI protocol Gemini image-to-image edits send image and image1 fields', async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('latin1');
    const contentType = String(req.headers['content-type'] || '');
    const fieldNames = [...raw.matchAll(/Content-Disposition:[^\r\n]*\bname="([^"]+)"/gi)].map(match => match[1]);
    upstreamRequests.push({
      url: req.url,
      contentType,
      fieldNames,
      raw,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }));
  });
  const upstreamPort = await listen(upstream);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-antigravity-edits-'));
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
      NOVA_IMAGE_STREAM: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  child.stdout.on('data', chunk => { backendOutput += chunk; });
  child.stderr.on('data', chunk => { backendOutput += chunk; });
  t.after(async () => {
    await stopBackend(child);
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
    const response = await fetch(`${backendUrl}/api/nova/queue-status`);
    return response.ok;
  });

  const createResponse = await fetch(`${backendUrl}/api/nova/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      protocol: 'openai',
      mode: 'image-to-image',
      prompt: '淘宝主图3:4',
      model: 'gemini-3-pro-image-preview',
      parallelCount: 1,
      outputSize: '4K',
      aspectRatio: '3:4',
      images: [{
        mimeType: 'image/png',
        data: Buffer.from('ref-image').toString('base64'),
      }],
    }),
  });
  assert.equal(createResponse.status, 202);
  const { taskId } = await createResponse.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  });

  assert.equal(task.status, 'completed', backendOutput);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, '/v1/images/edits');
  assert.match(upstreamRequests[0].contentType, /multipart\/form-data/i);
  assert.ok(upstreamRequests[0].fieldNames.includes('image'));
  assert.ok(upstreamRequests[0].fieldNames.includes('image1'));
  assert.ok(upstreamRequests[0].fieldNames.includes('size'));
  assert.ok(upstreamRequests[0].fieldNames.includes('aspect_ratio'));
  assert.ok(upstreamRequests[0].fieldNames.includes('quality'));
  assert.ok(upstreamRequests[0].fieldNames.includes('image_size'));
  assert.equal(upstreamRequests[0].fieldNames.includes('stream'), false);
});
