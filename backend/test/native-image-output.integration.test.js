const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const image = { data: PNG, mimeType: 'image/png' };
// Two-frame animation with the loop extension, not a static GIF fixture.
const GIF = 'R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAQABAAAIBAABBAQAIfkEARQAAQAsAAAAAAEAAQCBAIAAAAAAAAAAAAAACAQAAQQEADs=';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><title>蔬菜</title><circle cx="64" cy="64" r="60"/></svg>';

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

test('native media uses Images API and preserves provider routing and original bytes', async t => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/native.gif') {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from(GIF, 'base64'));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: req.url, body, authorization: req.headers.authorization });
      if (req.url !== '/v1/images/generations') {
        res.writeHead(404);
        res.end('Unexpected endpoint');
        return;
      }
      if (body.prompt.startsWith('native-svg-error')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'bad_request', message: SVG } }));
        return;
      }
      if (body.prompt.startsWith('native-svg-raw')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(SVG);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body.prompt.startsWith('native-gif-url')) {
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${upstream.address().port}/native.gif` }] }));
      } else {
        const bytes = body.prompt.startsWith('native-svg') ? Buffer.from(SVG).toString('base64')
          : body.prompt.startsWith('native-gif') ? GIF : PNG;
        res.end(JSON.stringify({ data: [{ b64_json: bytes }] }));
      }
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer();
  const backendPort = await listen(probe);
  await close(probe);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-native-output-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(backendPort),
      NOVA_TASK_DB: path.join(temp, 'tasks.sqlite'), NOVA_IMAGE_DIR: path.join(temp, 'images'),
      NOVA_IMAGE_STREAM: 'true', NOVA_RATE_LIMIT_MAX_REQUESTS_PER_IP: '10000', NOVA_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY: '10000' },
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
    outputSize: 'auto', aspectRatio: 'auto', images: [], gptImageQuality: 'high', gptImageBackground: 'opaque' };
  async function create(overrides) {
    return fetch(`${base}/api/nova/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...defaults, ...overrides }) });
  }
  async function finished(overrides, expectedStatus = 'completed') {
    const response = await create(overrides);
    assert.equal(response.status, 202, await response.clone().text());
    const { taskId } = await response.json();
    const task = await waitFor(async () => {
      const value = await fetch(`${base}/api/nova/tasks/${taskId}`).then(result => result.json());
      return ['completed', 'failed'].includes(value.status) ? value : null;
    });
    assert.equal(task.status, expectedStatus, JSON.stringify({ task, output }));
    return { ...requests.at(-1), task };
  }

  for (const format of ['svg', 'gif']) {
    for (const model of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']) {
      await t.test(`${model} ${format} sends native parameters and preserves native bytes`, async () => {
        const result = await finished({ model, gptImageOutputFormat: format, prompt: `native-${format}` });
        assert.equal(result.url, '/v1/images/generations');
        assert.equal(result.authorization, `Bearer ${defaults.apiKey}`);
        assert.equal(result.body.model, model);
        assert.equal(result.body.output_format, format);
        assert.equal(result.body.n, 1);
        assert.equal(result.body.stream, false);
        assert.equal(result.body.partial_images, undefined);
        assert.equal(result.body.response_format, undefined);
        assert.equal(result.body.output_compression, undefined);
        assert.equal(result.body.messages, undefined);
        assert.equal(result.body.image, undefined);
        assert.equal(result.body.quality, 'high');
        assert.equal(result.body.background, 'opaque');
        if (format === 'gif') {
          assert.equal(result.body.frame_count, 9);
          assert.equal(result.body.frame_duration_ms, 200);
        } else {
          assert.equal(result.body.prompt, 'native-svg');
          assert.equal(result.body.frame_count, undefined);
          assert.equal(result.body.frame_duration_ms, undefined);
        }
        const response = await fetch(base + result.task.result.images[0].slice(4));
        assert.equal(response.headers.get('content-type'), format === 'svg' ? 'image/svg+xml' : 'image/gif');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), format === 'svg' ? Buffer.from(SVG) : Buffer.from(GIF, 'base64'));
        if (format === 'svg') assert.match(response.headers.get('content-security-policy'), /sandbox/);
      });
    }
  }
  await t.test('accepts raw SVG bytes from a compatible image endpoint', async () => {
    const result = await finished({ gptImageOutputFormat: 'svg', prompt: 'native-svg-raw' });
    const response = await fetch(base + result.task.result.images[0].slice(4));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(SVG));
  });
  await t.test('upstream error containing SVG remains a failed task with no retry', async () => {
    const count = requests.length;
    const result = await finished({ gptImageOutputFormat: 'svg', prompt: 'native-svg-error' }, 'failed');
    assert.equal(requests.length, count + 1);
    assert.match(result.task.error, /400/);
    assert.equal(result.task.result, undefined);
  });
  await t.test('forwards bounded GIF timing, rounds to 10ms, and preserves a URL response', async () => {
    const result = await finished({ model: 'gpt-image-2.6', prompt: 'native-gif-url', gptImageOutputFormat: 'gif', gifFrameCount: 16, gifFrameDurationMs: 85 });
    assert.equal(result.body.model, 'gpt-image-2.6');
    assert.equal(result.body.frame_count, 16);
    assert.equal(result.body.frame_duration_ms, 90);
    assert.equal(result.body.stream, false);
    assert.equal(result.body.partial_images, undefined);
    const download = await fetch(base + result.task.result.images[0].slice(4));
    assert.equal(download.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(GIF, 'base64'));
  });
  await t.test('reports static PNG honestly and preserves custom Pro dimensions', async () => {
    const result = await finished({ model: 'gpt-image-2.6-sunburst-pro', gptImageOutputFormat: 'gif', customSize: '3264x2448' });
    assert.equal(result.body.size, '3264x2448');
    assert.match(result.task.warning, /PNG/);
    const response = await fetch(base + result.task.result.images[0].slice(4));
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, 'base64'));
  });
  for (const format of ['gif', 'svg']) {
    for (const overrides of [
      { mode: 'image-to-image', images: [image] },
      { mode: 'text-to-image', images: [image] },
      { mode: 'image-to-image', images: [] },
      { protocol: 'google' },
      { model: 'gpt-image-2' },
      { mode: 'image-to-image', images: [image], gptImageMarkup: image },
      ...(format === 'gif' ? [
        { gifFrameCount: 0 }, { gifFrameCount: 1 }, { gifFrameCount: 17 },
        { gifFrameDurationMs: 19 }, { gifFrameDurationMs: 2001 },
        { gifFrameCount: 1.5 }, { gifFrameDurationMs: null },
      ] : []),
    ]) {
      await t.test(`rejects unsupported native ${format} request ${JSON.stringify(overrides)}`, async () => {
        const count = requests.length;
        const response = await create({ gptImageOutputFormat: format, ...overrides });
        assert.equal(response.status, 400, await response.text());
        assert.equal(requests.length, count);
      });
    }
  }
});
