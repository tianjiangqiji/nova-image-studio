const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const image = { data: PNG, mimeType: 'image/png' };
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="60"/></svg>';

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

test('native media preserves provider routing, file bytes and the text-only GIF contract', async t => {
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
      const bytes = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      const body = contentType.startsWith('multipart/')
        ? await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData()
        : JSON.parse(bytes.toString('utf8'));
      requests.push({ url: req.url, body });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'bad_request', message: SVG } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (body.prompt.startsWith('native-gif-url')) {
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${upstream.address().port}/native.gif` }] }));
      } else {
        res.end(JSON.stringify({ data: [{ b64_json: body.prompt.startsWith('native-gif') ? `data:image/png;base64,${GIF}` : PNG }] }));
      }
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-markup-'));
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
    return { ...requests.at(-1), task };
  }

  for (const format of ['svg', 'gif']) {
    for (const mode of format === 'gif' ? ['text-to-image'] : ['text-to-image', 'image-to-image']) {
      await t.test(`${format} ${mode} preserves native bytes`, async () => {
        const result = await completed({ gptImageOutputFormat: format, prompt: `native-${format}`, mode,
          images: mode === 'image-to-image' ? [image] : [] });
        assert.equal(result.url, format === 'svg' ? '/v1/chat/completions' : '/v1/images/generations');
        assert.equal(result.body.model, defaults.model);
        if (format === 'gif') {
          assert.equal(result.body.response_format, 'url');
          assert.equal(result.body.output_format, 'gif');
          assert.equal(result.body.stream, false);
          assert.equal(result.body.partial_images, undefined);
          assert.equal(result.body.frame_count, 20);
          assert.equal(result.body.frame_duration_ms, 200);
          assert.equal(result.body.image, undefined);
        }
        if (mode === 'image-to-image') assert.equal(result.body.messages[0].content[1].image_url.url, `data:image/png;base64,${PNG}`);
        const response = await fetch(base + result.task.result.images[0].slice(4));
        assert.equal(response.headers.get('content-type'), format === 'svg' ? 'image/svg+xml' : 'image/gif');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), format === 'svg' ? Buffer.from(SVG) : Buffer.from(GIF, 'base64'));
        if (format === 'svg') assert.match(response.headers.get('content-security-policy'), /sandbox/);
      });
    }
  }
  await t.test('forwards custom GIF timing and preserves a URL response', async () => {
    const result = await completed({ model: 'gpt-image-2.6', prompt: 'native-gif-url', gptImageOutputFormat: 'gif', gifFrameCount: 24, gifFrameDurationMs: 80 });
    assert.equal(result.body.model, 'gpt-image-2.6');
    assert.equal(result.body.frame_count, 24);
    assert.equal(result.body.frame_duration_ms, 80);
    assert.equal(result.body.stream, false);
    assert.equal(result.body.partial_images, undefined);
    const download = await fetch(base + result.task.result.images[0].slice(4));
    assert.equal(download.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(GIF, 'base64'));
  });
  await t.test('reports static PNG honestly and preserves custom Pro dimensions', async () => {
    const result = await completed({ model: 'gpt-image-2.6-sunburst-pro', gptImageOutputFormat: 'gif', customSize: '3264x2448' });
    assert.equal(result.body.size, '3264x2448');
    assert.match(result.task.warning, /PNG/);
    const response = await fetch(base + result.task.result.images[0].slice(4));
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, 'base64'));
  });
  for (const overrides of [
    { mode: 'image-to-image', images: [image] },
    { mode: 'text-to-image', images: [image] },
    { mode: 'image-to-image', images: [] },
    { protocol: 'google' },
    { model: 'gpt-image-2' },
    { gifFrameCount: 0 },
    { gifFrameDurationMs: -1 },
    { gifFrameCount: 1.5 },
    { gifFrameDurationMs: null },
  ]) {
    await t.test(`rejects unsupported native GIF request ${JSON.stringify(overrides)}`, async () => {
      const count = requests.length;
      const response = await create({ gptImageOutputFormat: 'gif', ...overrides });
      assert.equal(response.status, 400, await response.text());
      assert.equal(requests.length, count);
    });
  }
});
