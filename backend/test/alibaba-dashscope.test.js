const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_DASHSCOPE_BASE_URL,
  buildDashScopeImageUrl,
  buildDashScopeImagePayload,
  extractDashScopeImageUrl,
} = require('../alibaba-dashscope');

const suffix = '/api/v1/services/aigc/multimodal-generation/generation';

test('buildDashScopeImageUrl 归一各种 baseUrl 形态', () => {
  assert.equal(buildDashScopeImageUrl('https://dashscope.aliyuncs.com'), `https://dashscope.aliyuncs.com${suffix}`);
  assert.equal(buildDashScopeImageUrl('https://dashscope.aliyuncs.com/'), `https://dashscope.aliyuncs.com${suffix}`);
  assert.equal(buildDashScopeImageUrl('https://dashscope.aliyuncs.com/api/v1'), `https://dashscope.aliyuncs.com${suffix}`);
  assert.equal(buildDashScopeImageUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'), `https://dashscope.aliyuncs.com${suffix}`);
  assert.equal(buildDashScopeImageUrl(''), `${DEFAULT_DASHSCOPE_BASE_URL}${suffix}`);
});

test('buildDashScopeImageUrl 剥离多段叠加后缀（compatible-mode/api/v1）', () => {
  // 用户从文档复制完整端点时可能带两段后缀，单次 replace 链剥不干净会 404
  assert.equal(
    buildDashScopeImageUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/api/v1'),
    `https://token-plan.cn-beijing.maas.aliyuncs.com${suffix}`,
  );
  assert.equal(
    buildDashScopeImageUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/api/v1/'),
    `https://token-plan.cn-beijing.maas.aliyuncs.com${suffix}`,
  );
});

test('buildDashScopeImageUrl 容忍被预剥过一层的半截形态', () => {
  // normalizeProtocolBaseUrl 等上游先剥掉 /v1 后会留下 /compatible-mode/api、/api 这类半截后缀
  assert.equal(
    buildDashScopeImageUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/api'),
    `https://token-plan.cn-beijing.maas.aliyuncs.com${suffix}`,
  );
  assert.equal(
    buildDashScopeImageUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/api'),
    `https://token-plan.cn-beijing.maas.aliyuncs.com${suffix}`,
  );
});

test('buildDashScopeImagePayload 文生图不带参考图、尺寸转成星号分隔', () => {
  const payload = buildDashScopeImagePayload({ model: 'qwen-image-3.0-pro', prompt: '画一只猫', images: [] }, '1024x1024');
  assert.equal(payload.model, 'qwen-image-3.0-pro');
  assert.deepEqual(payload.input.messages[0].content, [{ text: '画一只猫' }]);
  assert.equal(payload.parameters.size, '1024*1024');
});

test('buildDashScopeImagePayload 文生图也带 parameters.watermark=false', () => {
  const payload = buildDashScopeImagePayload(
    { model: 'qwen-image-3.0-pro', prompt: 'p', images: [] },
    '1024x1024',
  );
  assert.equal(payload.parameters.watermark, false);
});
test('buildDashScopeImagePayload 超出模型参考图上限时报错并给出建议', () => {
  const images = Array.from({ length: 4 }, () => ({ data: 'QUJD', mimeType: 'image/png' }));
  assert.throws(
    () => buildDashScopeImagePayload({ model: 'qwen-image-3.0-pro', prompt: 'p', images }, undefined),
    /最多支持 3 张参考图/,
  );
});

test('extractDashScopeImageUrl 取 output.choices[0].message.content 里的 image', () => {
  const data = { output: { choices: [{ message: { content: [{ text: 'ok' }, { image: 'https://example.com/a.png' }] } }] } };
  assert.equal(extractDashScopeImageUrl(data), 'https://example.com/a.png');
  assert.equal(extractDashScopeImageUrl({ output: { choices: [] } }), null);
  assert.equal(extractDashScopeImageUrl(null), null);
});

test('buildDashScopeImagePayload 图生图 content 先全部 image 再 text', () => {
  const images = [
    { data: 'AAA', mimeType: 'image/png' },
    { data: 'BBB', mimeType: 'image/jpeg' },
  ];
  const payload = buildDashScopeImagePayload(
    { model: 'qwen-image-3.0-pro', prompt: '改成水彩', images },
    '1024x1024',
  );
  assert.deepEqual(payload.input.messages[0].content, [
    { image: 'data:image/png;base64,AAA' },
    { image: 'data:image/jpeg;base64,BBB' },
    { text: '改成水彩' },
  ]);
});

test('buildDashScopeImagePayload 把大写 X 的 size 规范成星号', () => {
  const payload = buildDashScopeImagePayload(
    { model: 'qwen-image-3.0-pro', prompt: '画一只猫', images: [] },
    '1024X1024',
  );
  assert.equal(payload.parameters.size, '1024*1024');
});

test('buildDashScopeImagePayload 图生图有 size 时 parameters 带 watermark=false', () => {
  const payload = buildDashScopeImagePayload(
    { model: 'qwen-image-3.0-pro', prompt: 'p', images: [{ data: 'QUJD', mimeType: 'image/png' }] },
    '1024x1024',
  );
  assert.equal(payload.parameters.size, '1024*1024');
  assert.equal(payload.parameters.watermark, false);
});

test('buildDashScopeImagePayload 图生图无 size 仍带 parameters.watermark=false', () => {
  const payload = buildDashScopeImagePayload(
    { model: 'qwen-image-3.0-pro', prompt: 'p', images: [{ data: 'QUJD', mimeType: 'image/png' }] },
    undefined,
  );
  assert.deepEqual(payload.parameters, { watermark: false });
});

test('buildDashScopeImagePayload Wan 超过 9 张参考图抛错', () => {
  const images = Array.from({ length: 10 }, () => ({ data: 'QUJD', mimeType: 'image/png' }));
  assert.throws(
    () => buildDashScopeImagePayload({ model: 'wan2.7-image', prompt: 'p', images }, undefined),
    /最多支持 9 张参考图/,
  );
});
