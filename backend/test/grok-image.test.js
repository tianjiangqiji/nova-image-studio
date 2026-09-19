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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-grok-image-'));
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

function pngImage(label) {
  return {
    mimeType: 'image/png',
    data: Buffer.from(label).toString('base64'),
  };
}

test('Grok image-to-image sends official images[{type,url}] for one or many refs', async t => {
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
  const baseUrl = `http://127.0.0.1:${upstreamPort}`;

  async function createGrokEdit(images) {
    const response = await fetch(`${backendUrl}/api/nova/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'test-key',
        baseUrl,
        protocol: 'grok',
        mode: 'image-to-image',
        prompt: 'edit the image',
        model: 'grok-imagine-image',
        parallelCount: 1,
        outputSize: '1K',
        aspectRatio: '1:1',
        images,
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();
    const task = await waitTask(backendUrl, taskId, backendOutput);
    assert.equal(task.status, 'completed', backendOutput());
  }

  await createGrokEdit([pngImage('one')]);
  await createGrokEdit([pngImage('one'), pngImage('two')]);

  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[0].url, '/v1/images/edits');
  assert.equal(upstreamRequests[1].url, '/v1/images/edits');

  for (const request of upstreamRequests) {
    assert.equal('image' in request.body, false);
    assert.ok(Array.isArray(request.body.images));
    assert.equal(request.body.response_format, 'url');
    for (const item of request.body.images) {
      assert.equal(item.type, 'image_url');
      assert.match(item.url, /^data:image\/png;base64,/);
    }
  }
  assert.equal(upstreamRequests[0].body.images.length, 1);
  assert.equal(upstreamRequests[1].body.images.length, 2);
});

test('Grok image-to-image rejects more than 3 reference images', async t => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
      protocol: 'grok',
      mode: 'image-to-image',
      prompt: 'edit the image',
      model: 'grok-imagine-image',
      parallelCount: 1,
      outputSize: '1K',
      aspectRatio: '1:1',
      images: [pngImage('a'), pngImage('b'), pngImage('c'), pngImage('d')],
    }),
  });
  assert.equal(response.status, 202);
  const { taskId } = await response.json();
  const task = await waitTask(backendUrl, taskId, backendOutput);

  assert.equal(task.status, 'failed', backendOutput());
  assert.match(task.error, /最多.*3|3 张/);
  assert.equal(upstreamRequests.length, 0);
});
