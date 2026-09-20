const assert = require('node:assert/strict');
const test = require('node:test');

const { synthesizeUiSchema } = require('../plugin-runtime/schema-synthesizer');
const { validatePluginPackage } = require('../plugin-runtime/validate');
const { buildContext, submitTask, pollTask, normalizePollResponse, assertUrlAllowed } = require('../plugin-runtime/executor');

test('智能 UI 合成器：根据 manifest.json 自动推导完整合规的 uiSchema', () => {
  const manifest = {
    apiVersion: 1,
    id: 'test-sora',
    name: 'Sora 视频生成',
    version: '1.0.0',
    kind: 'video',
    mode: 'script',
    credential: {
      source: 'client',
      label: 'API Key',
      defaultBaseUrl: 'https://api.openai.com',
    },
    permissions: {
      hosts: ['api.openai.com'],
    },
    models: [
      { id: 'sora-1.0', name: 'Sora 1.0 标准版', price: { unit: 'per-second', amount: 0.1 } },
      { id: 'sora-turbo', name: 'Sora Turbo 极速版', price: { unit: 'per-second', amount: 0.05 } },
    ],
    media: {
      images: { maxCount: 1, label: '首帧参考图' },
      videos: { maxCount: 1, label: '参考视频' },
    },
    features: {
      aspectRatios: ['16:9', '9:16', '1:1'],
      durations: [5, 10],
      customControls: [
        {
          key: 'motion_strength',
          type: 'select',
          label: '动态幅度',
          default: 'medium',
          options: [
            { value: 'low', label: '轻微动效' },
            { value: 'medium', label: '自然动态' },
            { value: 'high', label: '剧烈运镜' },
          ],
        },
      ],
    },
  };

  const uiSchema = synthesizeUiSchema(manifest);

  assert.equal(uiSchema.apiVersion, 1);
  assert.equal(uiSchema.priceQuantityField, 'seconds');
  assert.ok(uiSchema.modelSelector);
  assert.equal(uiSchema.modelSelector.facets.length, 1);
  assert.equal(uiSchema.modelSelector.facets[0].key, 'targetModel');
  assert.equal(uiSchema.modelSelector.variants.length, 2);
  assert.equal(uiSchema.modelSelector.variants[0].targetModel, 'sora-1.0');

  const fieldKeys = uiSchema.fields.map(f => f.key);
  assert.ok(fieldKeys.includes('aspectRatio'));
  assert.ok(fieldKeys.includes('seconds'));
  assert.ok(fieldKeys.includes('images'));
  assert.ok(fieldKeys.includes('reference_videos'));
  assert.ok(fieldKeys.includes('motion_strength'));
  assert.ok(fieldKeys.includes('prompt'));

  // 布局检查
  assert.ok(uiSchema.layout.toolbar.includes('aspectRatio'));
  assert.ok(uiSchema.layout.toolbar.includes('motion_strength'));
  assert.ok(uiSchema.layout.body.includes('prompt'));
  assert.ok(uiSchema.layout.body.includes('images'));
});

test('校验器：双文件极简插件 (manifest.json + index.js) 校验通过并自动合成 uiSchema', () => {
  const manifest = {
    apiVersion: 1,
    id: 'mock-video',
    name: 'Mock Video Plugin',
    version: '1.0.0',
    kind: 'video',
    mode: 'script',
    credential: {
      source: 'client',
      label: 'API Key',
    },
    permissions: {
      hosts: ['api.mock.test'],
    },
    models: [
      { id: 'mock-v1', name: 'Mock V1' },
    ],
  };

  const driver = {
    buildSubmit(ctx) {
      return {
        url: `${ctx.baseUrl}/v1/videos`,
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.apiKey}` },
        body: { model: ctx.model, prompt: ctx.fields.prompt },
      };
    },
    buildQuery(taskId, ctx) {
      return {
        url: `${ctx.baseUrl}/v1/videos/${taskId}`,
        headers: { Authorization: `Bearer ${ctx.apiKey}` },
      };
    },
    parseTaskResult(payload) {
      if (payload.status === 'succeeded') {
        return { state: 'completed', progress: 100, assets: [{ url: payload.video_url }] };
      }
      return { state: 'processing', progress: payload.progress || 50 };
    },
  };

  const res = validatePluginPackage({
    manifest,
    dirName: 'mock-video',
    driver,
    hasScriptDriver: true,
  });

  assert.equal(res.ok, true, `校验应通过，但出现错误: ${res.message}`);
  assert.ok(res.uiSchema);
  assert.equal(res.uiSchema.fields.some(f => f.key === 'prompt'), true);
});

test('校验器：缺少 buildSubmit 函数的脚本驱动会被拦截', () => {
  const manifest = {
    apiVersion: 1,
    id: 'mock-invalid',
    name: 'Mock Invalid',
    version: '1.0.0',
    kind: 'video',
    mode: 'script',
    credential: { source: 'client', label: 'Key' },
    permissions: { hosts: ['api.mock.test'] },
    models: [{ id: 'm1', name: 'M1' }],
  };

  const driver = {}; // 缺少 buildSubmit

  const res = validatePluginPackage({
    manifest,
    dirName: 'mock-invalid',
    driver,
    hasScriptDriver: true,
  });

  assert.equal(res.ok, false);
  assert.match(res.message, /buildSubmit/);
});

test('执行器：脚本插件完整驱动调用与生命周期归一化', async () => {
  const plugin = {
    id: 'test-driver-plugin',
    manifest: {
      version: '1.0.0',
      credential: { defaultBaseUrl: 'https://api.upstream.test' },
      permissions: { hosts: ['api.upstream.test'] },
    },
    allowedHosts: new Set(['api.upstream.test']),
    driver: {
      buildSubmit(ctx) {
        return {
          url: `${ctx.baseUrl}/v1/generate`,
          method: 'POST',
          headers: { 'X-Custom-Key': ctx.apiKey },
          body: {
            prompt: ctx.fields.prompt,
            aspect_ratio: ctx.fields.aspectRatio,
            duration: ctx.fields.seconds,
          },
        };
      },
      parseSubmitResponse(payload) {
        return { taskId: payload.job_id };
      },
      buildQuery(taskId, ctx) {
        return {
          url: `${ctx.baseUrl}/v1/jobs/${taskId}`,
          method: 'GET',
          headers: { 'X-Custom-Key': ctx.apiKey },
        };
      },
      parseTaskResult(payload) {
        if (payload.state === 'DONE') {
          return {
            state: 'completed',
            progress: 100,
            assets: [{ url: payload.download_url }],
          };
        }
        if (payload.state === 'FAIL') {
          return {
            state: 'failed',
            error: payload.err_msg || '任务失败',
          };
        }
        return {
          state: 'processing',
          progress: payload.pct || 40,
        };
      },
    },
  };

  const baseCtx = {
    plugin,
    baseUrl: 'https://api.upstream.test',
    apiKey: 'secret-key-123',
    model: 'sora-1',
    facets: {},
    fields: { prompt: 'A cinematic drone shot', aspectRatio: '16:9', seconds: 5 },
    media: {},
  };

  const ctx = buildContext(baseCtx);

  // 验证 buildSubmit
  const submitReq = plugin.driver.buildSubmit(ctx);
  assert.equal(submitReq.url, 'https://api.upstream.test/v1/generate');
  assert.equal(submitReq.body.prompt, 'A cinematic drone shot');
  assert.equal(submitReq.headers['X-Custom-Key'], 'secret-key-123');

  // 验证 parseSubmitResponse
  const submitRes = plugin.driver.parseSubmitResponse({ job_id: 'job-999' });
  assert.equal(submitRes.taskId, 'job-999');

  // 验证 buildQuery
  const queryReq = plugin.driver.buildQuery('job-999', ctx);
  assert.equal(queryReq.url, 'https://api.upstream.test/v1/jobs/job-999');

  // 验证 normalizePollResponse 对 parseTaskResult 的调用
  const completedRes = normalizePollResponse(plugin, { state: 'DONE', download_url: 'https://cdn.test/video.mp4' }, ctx);
  assert.equal(completedRes.state, 'completed');
  assert.equal(completedRes.assets[0].url, 'https://cdn.test/video.mp4');

  const processingRes = normalizePollResponse(plugin, { state: 'RUNNING', pct: 65 }, ctx);
  assert.equal(processingRes.state, 'processing');
  assert.equal(processingRes.progress, 65);

  const failedRes = normalizePollResponse(plugin, { state: 'FAIL', err_msg: 'Prompt content policy violation' }, ctx);
  assert.equal(failedRes.state, 'failed');
  assert.equal(failedRes.error, 'Prompt content policy violation');

  // 验证越界未申报域名仍受安全网拦截
  assert.throws(
    () => assertUrlAllowed(plugin, 'https://evil.unauthorized.com/api', '测试请求'),
    /未在 manifest\.permissions\.hosts 中申报/,
  );
});
