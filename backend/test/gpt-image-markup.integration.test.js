const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateGptImageMarkup } = require('../gpt-image-markup');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const image = { data: PNG, mimeType: 'image/png' };

function pngHeader(width, height, colorType = 6) {
  const bytes = Buffer.from(PNG, 'base64');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[25] = colorType;
  return { data: bytes.toString('base64'), mimeType: 'image/png' };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for backend task');
}

test('standard GPT Image models preserve full quality and send independent markup without style', async t => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      const body = contentType.startsWith('multipart/')
        ? await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData()
        : JSON.parse(bytes.toString('utf8'));
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer();
  const backendPort = await listen(probe);
  await close(probe);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-markup-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(backendPort),
      NOVA_TASK_DB: path.join(temp, 'tasks.sqlite'), NOVA_IMAGE_DIR: path.join(temp, 'images'),
      NOVA_IMAGE_STREAM: 'false', NOVA_RATE_LIMIT_MAX_REQUESTS_PER_IP: '10000', NOVA_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await close(upstream);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${backendPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(output);
    return fetch(`${base}/api/nova/queue-status`).then(response => response.ok).catch(() => false);
  });
  const defaults = { apiKey: 'test-only-key', baseUrl: `http://127.0.0.1:${upstreamPort}`, protocol: 'openai',
    mode: 'text-to-image', prompt: 'edit the marked area', model: 'gpt-image-2.6-flare', parallelCount: 1,
    outputSize: 'auto', aspectRatio: 'auto', images: [], gptImageStyle: 'vivid' };
  async function create(overrides) {
    return fetch(`${base}/api/nova/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...defaults, ...overrides }) });
  }
  async function completed(overrides) {
    const response = await create(overrides);
    assert.equal(response.status, 202, await response.clone().text());
    const { taskId } = await response.json();
    const task = await waitFor(async () => {
      const value = await fetch(`${base}/api/nova/tasks/${taskId}`).then(result => result.json());
      return ['completed', 'failed'].includes(value.status) ? value : null;
    });
    assert.equal(task.status, 'completed', JSON.stringify({ task, output }));
    return requests.at(-1);
  }

  for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
    await t.test(`generation preserves ${quality} and ignores style`, async () => {
      const { url, body } = await completed({ gptImageQuality: quality });
      assert.equal(url, '/v1/images/generations');
      assert.equal(body.model, 'gpt-image-2.6-flare');
      assert.equal(body.quality, quality);
      assert.equal(body.output_format, 'png');
      assert.equal('style' in body, false);
    });
  }

  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']) {
    await t.test(`${model} edits preserve first image, extra references, and separate markup`, async () => {
      const { url, body } = await completed({ model, mode: 'image-to-image', images: [image, image],
        gptImageMarkup: image, gptImageQuality: 'max' });
      assert.equal(url, '/v1/images/edits');
      assert.equal(body.get('model'), model);
      assert.equal(body.get('quality'), 'max');
      assert.equal(body.has('style'), false);
      assert.equal(body.getAll('image').length, 2);
      assert.equal(body.get('markup').type, 'image/png');
      assert.equal(Buffer.from(await body.get('image').arrayBuffer()).toString('base64'), PNG);
      assert.equal(Buffer.from(await body.get('markup').arrayBuffer()).toString('base64'), PNG);
    });
  }

  const validEdit = { mode: 'image-to-image', images: [image], gptImageMarkup: image };
  const invalid = [
    ['older model', { model: 'gpt-image-2' }],
    ['different protocol', { protocol: 'google' }],
    ['generation mode', { mode: 'text-to-image' }],
    ['missing reference', { images: [] }],
    ['different dimensions', { gptImageMarkup: pngHeader(2, 1) }],
    ['opaque overlay', { gptImageMarkup: pngHeader(1, 1, 2) }],
    ['oversized reference', { images: [pngHeader(4097, 4096)] }],
    ['oversized overlay', { gptImageMarkup: pngHeader(4097, 4096) }],
    ['non-PNG overlay', { gptImageMarkup: { data: PNG, mimeType: 'image/jpeg' } }],
    ['mask conflict', { mask: image }],
    ['rewriter conflict', { prompt_rewriter: 'test' }],
  ];
  for (const [name, overrides] of invalid) {
    await t.test(`rejects ${name} before contacting the upstream`, async () => {
      const before = requests.length;
      const response = await create({ ...validEdit, ...overrides });
      assert.equal(response.status, 400, await response.text());
      assert.equal(requests.length, before);
    });
  }
});

test('markup overlay enforces the documented 50 MiB limit', () => {
  const bytes = Buffer.alloc(50 * 1024 * 1024 + 1);
  Buffer.from(PNG, 'base64').copy(bytes);
  assert.throws(() => validateGptImageMarkup({ protocol: 'openai', model: 'gpt-image-2.6-flare',
    mode: 'image-to-image', images: [image], gptImageMarkup: { data: bytes.toString('base64'), mimeType: 'image/png' } }), /50MB/);
});
