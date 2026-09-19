const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_ARK_BASE_URL,
  buildDoubaoImagesUrl,
  clampSizeToPixelRange,
  resolveDoubaoImageSize,
  buildDoubaoImagePayload,
} = require('../doubao');

test('buildDoubaoImagesUrl 归一各种 baseUrl 形态', () => {
  const suffix = '/v3/images/generations';
  assert.equal(buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api'), `https://ark.cn-beijing.volces.com/api${suffix}`);
  assert.equal(buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api/v3'), `https://ark.cn-beijing.volces.com/api${suffix}`);
  assert.equal(buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api/plan/v3'), `https://ark.cn-beijing.volces.com/api/plan${suffix}`);
  assert.equal(buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api/plan/v3/'), `https://ark.cn-beijing.volces.com/api/plan${suffix}`);
  assert.equal(buildDoubaoImagesUrl(''), `${DEFAULT_ARK_BASE_URL}${suffix}`);
});

test('buildDoubaoImagesUrl 已含 generations 路径时不重复拼接', () => {
  assert.equal(
    buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api/v3/images/generations'),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  );
  assert.equal(
    buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api/v3/images/generations/'),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  );
  assert.equal(
    buildDoubaoImagesUrl('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations'),
    'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations',
  );
});

test('clampSizeToPixelRange 把过小的 1K 尺寸放大到 seedream 最小像素', () => {
  assert.equal(clampSizeToPixelRange('1024x1024'), '1920x1920');
  assert.equal(clampSizeToPixelRange('2048x2048'), '2048x2048');
  const clamped = clampSizeToPixelRange('1456x816');
  const [w, h] = clamped.split('x').map(Number);
  assert.ok(w * h >= 3686400, `${clamped} 像素不足`);
  assert.ok(w % 16 === 0 && h % 16 === 0);
  assert.equal(clampSizeToPixelRange('not-a-size'), null);
});

test('clampSizeToPixelRange 超长边缩到 4096 且总像素仍达标', () => {
  for (const input of ['688x5440', '256x2048', '256x1024']) {
    const clamped = clampSizeToPixelRange(input);
    assert.ok(clamped, `${input} 应返回有效尺寸`);
    const [w, h] = clamped.split('x').map(Number);
    assert.ok(w <= 4096 && h <= 4096, `${input} → ${clamped} 有边超过 4096`);
    assert.ok(w * h >= 3686400, `${input} → ${clamped} 像素不足`);
    assert.ok(w % 16 === 0 && h % 16 === 0, `${clamped} 未 16 对齐`);
  }
});

test('resolveDoubaoImageSize 空尺寸按档位兜底', () => {
  assert.equal(resolveDoubaoImageSize({ outputSize: '1K' }, () => undefined), '2K');
  assert.equal(resolveDoubaoImageSize({ outputSize: '4K' }, () => undefined), '4K');
  assert.equal(resolveDoubaoImageSize({ outputSize: '2K' }, () => '2048x2048'), '2048x2048');
});

test('buildDoubaoImagePayload 图生图走 image 参数且默认去水印', () => {
  const payload = buildDoubaoImagePayload({
    model: 'doubao-seedream-5.0-lite',
    prompt: '改背景',
    images: [{ data: 'QUJD', mimeType: 'image/png' }],
  }, '2048x2048');
  assert.equal(payload.model, 'doubao-seedream-5.0-lite');
  assert.equal(payload.response_format, 'b64_json');
  assert.equal(payload.watermark, false);
  assert.equal(payload.size, '2048x2048');
  assert.deepEqual(payload.image, ['data:image/png;base64,QUJD']);
  const t2i = buildDoubaoImagePayload({ model: 'm', prompt: 'p', images: [] }, undefined);
  assert.equal('image' in t2i, false);
  assert.equal('size' in t2i, false);
});
