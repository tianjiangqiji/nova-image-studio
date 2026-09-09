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

test('antigravity Gemini 图生图多张参考图走 image1/image2/image3 字段（antigravity 实测格式）', { timeout: 60000 }, async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('latin1');
    const contentType = String(req.headers['content-type'] || '');
    const fieldNames = [...raw.matchAll(/Content-Disposition:[^\r\n]*\bname="([^"]+)"/gi)].map(match => match[1]);
    upstreamRequests.push({ url: req.url, contentType, fieldNames, raw });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
    }));
  });
  const upstreamPort = await listen(upstream);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-antigravity-edits-'));
  const probe = http.createServer();
  const backendPortReal = await new Promise(resolve => {
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close();
      resolve(port);
    });
  });

  const child = spawn(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
    cwd: tempDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(backendPortReal),
      HOSTNAME: '127.0.0.1',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
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

  const backendUrl = `http://127.0.0.1:${backendPortReal}`;
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
      prompt: '以图1为主体，参考图2的材质与图3的配色，生成一张淘宝主图。',
      model: 'gemini-3.1-flash-image',
      parallelCount: 1,
      outputSize: '2K',
      aspectRatio: '3:4',
      images: [
        { mimeType: 'image/png', data: Buffer.from('ref-1').toString('base64') },
        { mimeType: 'image/png', data: Buffer.from('ref-2').toString('base64') },
        { mimeType: 'image/jpeg', data: Buffer.from('ref-3').toString('base64') },
      ],
    }),
  });
  assert.equal(createResponse.status, 202, backendOutput);
  const { taskId } = await createResponse.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/nova/tasks/${taskId}`);
    const value = await response.json();
    return ['completed', 'failed'].includes(value.status) ? value : null;
  });

  assert.equal(task.status, 'completed', backendOutput);
  assert.equal(upstreamRequests.length, 1);
  const req = upstreamRequests[0];
  assert.equal(req.url, '/v1/images/edits');
  assert.match(req.contentType, /multipart\/form-data/);
  // 第一张同时写通用 image 字段，三张各自写 image1/image2/image3
  assert.equal(req.fieldNames.filter(name => name === 'image').length, 1, '第一张参考图应写一次通用 image 字段');
  for (const name of ['image1', 'image2', 'image3']) {
    assert.equal(req.fieldNames.filter(field => field === name).length, 1, `应包含 ${name} 字段`);
  }
  // antigravity 专属字段：imageSize/image_size + aspect_ratio + quality，且不携带 stream/partial_images
  for (const name of ['model', 'prompt', 'n', 'size', 'aspect_ratio', 'quality', 'image_size', 'imageSize']) {
    assert.ok(req.fieldNames.includes(name), `应包含 ${name} 字段`);
  }
  assert.ok(!req.fieldNames.includes('stream'), 'antigravity 不应携带 stream 字段');
  assert.ok(!req.fieldNames.includes('partial_images'), 'antigravity 不应携带 partial_images 字段');
  const rawUtf8 = Buffer.from(req.raw, 'latin1').toString('utf8');
  assert.ok(rawUtf8.includes('2K'), 'imageSize 应为 2K');
  assert.ok(rawUtf8.includes('3:4'), 'aspect_ratio 应为 3:4');
});
