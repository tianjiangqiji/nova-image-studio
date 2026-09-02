const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveTemplate } = require('../plugin-runtime/template');
const { classifyStatus, extractProgress, normalizeResult, pickFirstString } = require('../plugin-runtime/extract');
const { validatePluginPackage } = require('../plugin-runtime/validate');
const { validateAndNormalizeInput, resolveModelFromFacets, InputError } = require('../plugin-runtime/input');
const { buildContext, assertUrlAllowed, isLocallyScopedHost } = require('../plugin-runtime/executor');
const { verifyPlugin } = require('../plugin-runtime/verify');
const registry = require('../plugin-runtime/registry');

const H3 = 'ccode-h3';

function h3Plugin() {
  const plugin = registry.getPlugin(H3);
  assert.ok(plugin, `插件 ${H3} 应能加载成功。加载失败原因: ${JSON.stringify(registry.listFailures())}`);
  return plugin;
}

// ===== 模板求值 =====

test('整串单表达式保留原始类型', () => {
  const ctx = { fields: { seconds: 8, list: ['a', 'b'] } };
  assert.equal(resolveTemplate('{{fields.seconds}}', ctx), 8);
  assert.deepEqual(resolveTemplate('{{fields.list}}', ctx), ['a', 'b']);
  assert.equal(resolveTemplate('{{string fields.seconds}}', ctx), '8');
});

test('插值到字符串中间时空值渲染为空串', () => {
  const ctx = { baseUrl: 'https://x.test', upstreamTaskId: 'abc' };
  assert.equal(resolveTemplate('{{baseUrl}}/v1/videos/{{upstreamTaskId}}', ctx), 'https://x.test/v1/videos/abc');
  assert.equal(resolveTemplate('{{baseUrl}}/v1/videos/{{missing}}', ctx), 'https://x.test/v1/videos/');
});

test('对象字段的空值被丢弃，$keep 可保留', () => {
  const resolved = resolveTemplate(
    { a: '{{missing}}', b: '{{list}}', c: '{{zero}}', d: { $keep: '{{missing}}' } },
    { list: [], zero: 0 },
  );
  assert.deepEqual(resolved, { c: 0, d: null });
});

test('$switch 命中 / 未命中 / 默认值', () => {
  const spec = { $switch: '{{facet.resolution}}', $cases: { '2K': '2K', '4K': '4K' } };
  assert.equal(resolveTemplate(spec, { facet: { resolution: '2K' } }), '2K');
  assert.equal(resolveTemplate(spec, { facet: { resolution: '768P' } }), undefined);
  assert.equal(
    resolveTemplate({ ...spec, $default: 'auto' }, { facet: { resolution: '768P' } }),
    'auto',
  );
});

test('concat 展平数组并丢空项，join 拼接', () => {
  const ctx = { media: { firstFrame: ['a'], lastFrame: [], multiImage: ['b', 'c'] } };
  assert.deepEqual(resolveTemplate('{{concat media.firstFrame media.lastFrame}}', ctx), ['a']);
  assert.deepEqual(resolveTemplate('{{concat media.firstFrame media.multiImage}}', ctx), ['a', 'b', 'c']);
  assert.equal(resolveTemplate("{{join ',' media.multiImage}}", ctx), 'b,c');
});

test('未知函数报错而不是静默当成路径', () => {
  assert.throws(() => resolveTemplate('{{nope a b}}', {}), /未知的模板函数/);
});

// ===== 上游响应取值 =====

test('状态词表归一化，未识别时按 processing 处理', () => {
  const spec = {
    completed: ['completed', 'success'],
    failed: ['failed'],
    queued: ['queued'],
    processing: ['processing'],
  };
  assert.equal(classifyStatus({ status: 'Success' }, spec, 't').state, 'completed');
  assert.equal(classifyStatus({ state: 'queued' }, spec, 't').state, 'queued');
  const unknown = classifyStatus({ status: 'wat' }, spec, 't');
  assert.equal(unknown.state, 'processing');
  assert.equal(unknown.recognized, false);
});

test('进度不做量纲猜测', () => {
  assert.equal(extractProgress({ progress: 42 }, { from: ['progress'] }), 42);
  assert.equal(extractProgress({ progress: '42' }, { from: ['progress'] }), 42);
  assert.equal(extractProgress({ progress: 0.5 }, { from: ['progress'], scale: '0-1' }), 50);
  assert.equal(extractProgress({}, { from: ['progress'] }), undefined);
  assert.equal(extractProgress({ progress: 'n/a' }, { from: ['progress'] }), undefined);
});

test('候选路径按顺序取第一个非空值', () => {
  assert.equal(pickFirstString({ b: 'second' }, ['a', 'b']), 'second');
  assert.equal(pickFirstString({ data: [{ url: 'deep' }] }, ['x', 'data.0.url']), 'deep');
  assert.equal(pickFirstString({ a: {} }, ['a']), undefined);
});

test('产物归一化：URL 改写与 fallback', () => {
  const spec = {
    assets: [{
      kind: 'video',
      url: ['video_url'],
      fallbackUrl: 'https://cdn.test/v1/videos/{{upstreamTaskId}}/content',
    }],
    rewriteHosts: { 'origin.internal.test': 'cdn.test' },
  };
  const ctx = { upstreamTaskId: 'task-1' };

  const rewritten = normalizeResult(
    { video_url: 'https://origin.internal.test/a.mp4' }, spec, ctx, resolveTemplate);
  assert.equal(rewritten.assets[0].url, 'https://cdn.test/a.mp4');

  const untouched = normalizeResult(
    { video_url: 'https://other.test/a.mp4' }, spec, ctx, resolveTemplate);
  assert.equal(untouched.assets[0].url, 'https://other.test/a.mp4');

  const fallback = normalizeResult({}, spec, ctx, resolveTemplate);
  assert.equal(fallback.assets[0].url, 'https://cdn.test/v1/videos/task-1/content');
});

test('没有 rewriteHosts 时产物地址原样保留', () => {
  // ccode-h3 刻意不做域名改写：产物用上游返回的原生地址
  const plugin = h3Plugin();
  assert.equal(plugin.provider.poll.result.rewriteHosts, undefined);
  const normalized = normalizeResult(
    { video_url: 'https://out.upstream.test/a.mp4' },
    plugin.provider.poll.result,
    { upstreamTaskId: 'x', baseUrl: 'https://pro.ccode.vip' },
    resolveTemplate,
  );
  assert.equal(normalized.assets[0].url, 'https://out.upstream.test/a.mp4');
});

// ===== 校验器 =====

test('校验器指出具体是哪个字段写错了', () => {
  const result = validatePluginPackage({
    manifest: { apiVersion: 1, id: 'Bad_Id', name: '', version: 'x', kind: 'audio' },
    uiSchema: { apiVersion: 2 },
    provider: {},
    dirName: 'bad-id',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /manifest\.id/);
  assert.match(result.message, /manifest\.version/);
  assert.match(result.message, /manifest\.kind/);
  assert.match(result.message, /ui\.schema\.apiVersion/);
  assert.match(result.message, /provider\.submit/);
});

test('manifest.id 必须与目录名一致', () => {
  const plugin = h3Plugin();
  const result = validatePluginPackage({
    manifest: plugin.manifest,
    uiSchema: plugin.uiSchema,
    provider: plugin.provider,
    dirName: 'other-dir',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /必须与插件目录名/);
});

test('variants 引用未申报的模型会被拦下', () => {
  const plugin = h3Plugin();
  const uiSchema = JSON.parse(JSON.stringify(plugin.uiSchema));
  uiSchema.modelSelector.variants[0].model = 'not-declared';
  const result = validatePluginPackage({
    manifest: plugin.manifest, uiSchema, provider: plugin.provider, dirName: H3,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /未在 manifest\.models 中申报/);
});

// ===== 注册表 + H3 插件包 =====

test('ccode-h3 插件通过全部校验并被加载', () => {
  const plugin = h3Plugin();
  assert.equal(plugin.manifest.models.length, 8);
  assert.equal(plugin.uiSchema.modelSelector.variants.length, 8);
  assert.ok(plugin.allowedHosts.has('pro.ccode.vip'));
});

test('下发给前端的描述不含 provider 模板', () => {
  const described = registry.describeForClient(h3Plugin());
  assert.equal(described.provider, undefined);
  assert.equal(described.models.length, 8);
  assert.equal(described.models[0].price.unit, 'per-second');
  assert.ok(described.uiSchema.modelSelector);
});

// ===== facet 反解模型 =====

test('facet 组合反解模型 ID', () => {
  const { uiSchema } = h3Plugin();
  assert.equal(resolveModelFromFacets(uiSchema, { tier: 'standard', resolution: '1080P' }), 'minimax-h3-original-1080p');
  assert.equal(resolveModelFromFacets(uiSchema, { tier: 'lite', resolution: '768P' }), 'minimax-h3-quantized-768p');
  // 漫画版没有 1080P
  assert.equal(resolveModelFromFacets(uiSchema, { tier: 'comic', resolution: '1080P' }), null);
});

// ===== 入参校验 =====

const MEDIA = kind => `https://host.test/api/nova/plugin-media/${kind}.png`;

function baseInput(overrides = {}) {
  return {
    facets: { tier: 'standard', resolution: '768P' },
    fields: { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: '一只猫' },
    media: {},
    ...overrides,
  };
}

test('合规入参归一化后只保留可见字段', () => {
  const result = validateAndNormalizeInput(h3Plugin(), baseInput());
  assert.equal(result.model, 'minimax-h3-original-768p');
  assert.deepEqual(result.fields, { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: '一只猫' });
  assert.deepEqual(result.media, {});
});

test('不可见字段的残留值被丢弃', () => {
  const result = validateAndNormalizeInput(h3Plugin(), baseInput({
    // 全能参考模式下首尾帧不可见，切档位残留的素材不应被提交
    media: { firstFrame: [MEDIA('a')] },
  }));
  assert.equal(result.media.firstFrame, undefined);
});

test('2K / 4K 必须带参考图', () => {
  const plugin = h3Plugin();
  assert.throws(
    () => validateAndNormalizeInput(plugin, baseInput({ facets: { tier: 'standard', resolution: '2K' } })),
    /参考图片.*必填/,
  );
  const ok = validateAndNormalizeInput(plugin, baseInput({
    facets: { tier: 'standard', resolution: '2K' },
    media: { multiImage: [MEDIA('a')] },
  }));
  assert.equal(ok.model, 'minimax-h3-original-cf-2k');
});

test('首尾帧模式必须有首帧，尾帧可选', () => {
  const plugin = h3Plugin();
  const fl2v = overrides => baseInput({
    fields: { mode: 'first-last-frame', aspectRatio: '9:16', seconds: 8, prompt: 'p' },
    ...overrides,
  });
  assert.throws(() => validateAndNormalizeInput(plugin, fl2v()), /首帧.*必填/);
  const ok = validateAndNormalizeInput(plugin, fl2v({ media: { firstFrame: [MEDIA('a')] } }));
  assert.deepEqual(ok.media, { firstFrame: [MEDIA('a')] });
});

test('量化版不支持首尾帧，也不支持视频/音频参考', () => {
  const plugin = h3Plugin();
  assert.throws(
    () => validateAndNormalizeInput(plugin, baseInput({
      facets: { tier: 'lite', resolution: '768P' },
      fields: { mode: 'first-last-frame', aspectRatio: '9:16', seconds: 8, prompt: 'p' },
    })),
    /不支持/,
  );
  assert.throws(
    () => validateAndNormalizeInput(plugin, baseInput({
      facets: { tier: 'lite', resolution: '768P' },
      media: { multiVideo: [MEDIA('v')] },
    })),
    /参考视频.*最多 0 个/,
  );
});

test('量化版参考图上限收紧到 4 张', () => {
  const plugin = h3Plugin();
  const five = Array.from({ length: 5 }, (_, i) => MEDIA(`i${i}`));
  assert.throws(
    () => validateAndNormalizeInput(plugin, baseInput({
      facets: { tier: 'lite', resolution: '768P' },
      media: { multiImage: five },
    })),
    /最多 4 个/,
  );
});

test('不存在的 facet 组合被拒绝', () => {
  assert.throws(
    () => validateAndNormalizeInput(h3Plugin(), baseInput({ facets: { tier: 'comic', resolution: '1080P' } })),
    /没有对应的模型/,
  );
});

test('前端声明的 model 与 facet 组合不一致时拒绝', () => {
  assert.throws(
    () => validateAndNormalizeInput(h3Plugin(), baseInput({ model: 'minimax-h3-quantized-768p' })),
    /模型与参数组合不匹配/,
  );
});

test('提示词为空、超长、以及非法枚举值都被拦下', () => {
  const plugin = h3Plugin();
  assert.throws(() => validateAndNormalizeInput(plugin, baseInput({
    fields: { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: '   ' },
  })), /不能为空/);
  assert.throws(() => validateAndNormalizeInput(plugin, baseInput({
    fields: { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: 'x'.repeat(5001) },
  })), /5000 字上限/);
  assert.throws(() => validateAndNormalizeInput(plugin, baseInput({
    fields: { mode: 'multi-reference', aspectRatio: '32:9', seconds: 8, prompt: 'p' },
  })), /画面比例.*无效/);
  assert.throws(() => validateAndNormalizeInput(plugin, baseInput({
    fields: { mode: 'multi-reference', aspectRatio: '9:16', seconds: 99, prompt: 'p' },
  })), /视频时长.*无效/);
});

test('外部素材地址不被接受', () => {
  assert.throws(
    () => validateAndNormalizeInput(h3Plugin(), baseInput({
      media: { multiImage: ['https://evil.test/a.png'] },
    })),
    /无效的素材地址/,
  );
});

test('InputError 是可识别的错误类型', () => {
  try {
    validateAndNormalizeInput(h3Plugin(), baseInput({ facets: {} }));
    assert.fail('应当抛错');
  } catch (error) {
    assert.ok(error instanceof InputError);
  }
});

// ===== 端到端：入参 → 上游请求体 =====
//
// 这几条是协议表达力的验收标准：商业分支里 createVideoTaskBackend 手写的每一条
// H3 特例（seconds 必须是字符串、size 与 aspect_ratio 互斥、fl2v 拼首尾帧、
// 可选素材字段有就传），都必须能纯靠 provider.json 表达出来。

function buildSubmitBody(input) {
  const plugin = h3Plugin();
  const normalized = validateAndNormalizeInput(plugin, input);
  const context = buildContext({
    plugin,
    baseUrl: 'https://pro.ccode.vip',
    apiKey: 'sk-test',
    model: normalized.model,
    facets: normalized.facets,
    fields: normalized.fields,
    media: normalized.media,
  });
  return resolveTemplate(plugin.provider.submit.body, context);
}

test('普通档位只传 aspect_ratio，不传 size', () => {
  const body = buildSubmitBody(baseInput());
  assert.deepEqual(body, {
    model: 'minimax-h3-original-768p',
    prompt: '一只猫',
    // 上游 Go 服务要求 seconds 是字符串，传数字会报 cannot unmarshal number
    seconds: '8',
    aspect_ratio: '9:16',
  });
  assert.equal('size' in body, false);
  assert.equal('workflow_id' in body, false);
});

test('CF 超分档位同时传 size 与 aspect_ratio', () => {
  const body = buildSubmitBody(baseInput({
    facets: { tier: 'standard', resolution: '4K' },
    media: { multiImage: [MEDIA('a')] },
  }));
  assert.equal(body.model, 'minimax-h3-original-cf-4k');
  assert.equal(body.size, '4K');
  assert.equal(body.aspect_ratio, '9:16');
  assert.deepEqual(body.images, [MEDIA('a')]);
});

test('首尾帧模式带 workflow_id，images 为首帧 + 尾帧', () => {
  const body = buildSubmitBody(baseInput({
    fields: { mode: 'first-last-frame', aspectRatio: '16:9', seconds: 6, prompt: 'p' },
    media: { firstFrame: [MEDIA('first')], lastFrame: [MEDIA('last')] },
  }));
  assert.equal(body.workflow_id, 'fl2v');
  assert.deepEqual(body.images, [MEDIA('first'), MEDIA('last')]);
  assert.equal('size' in body, false);
});

test('尾帧缺省时 images 只有首帧，不补空值', () => {
  const body = buildSubmitBody(baseInput({
    fields: { mode: 'first-last-frame', aspectRatio: '16:9', seconds: 6, prompt: 'p' },
    media: { firstFrame: [MEDIA('first')] },
  }));
  assert.deepEqual(body.images, [MEDIA('first')]);
});

test('参考视频 / 音频有就传，没有就整个字段不出现', () => {
  const withMedia = buildSubmitBody(baseInput({
    media: { multiImage: [MEDIA('i')], multiVideo: [MEDIA('v')], multiAudio: [MEDIA('a')] },
  }));
  assert.deepEqual(withMedia.reference_videos, [MEDIA('v')]);
  assert.deepEqual(withMedia.reference_audios, [MEDIA('a')]);

  const without = buildSubmitBody(baseInput());
  assert.equal('reference_videos' in without, false);
  assert.equal('reference_audios' in without, false);
  assert.equal('images' in without, false);
});

test('查询地址与鉴权头由模板拼出', () => {
  const plugin = h3Plugin();
  const context = buildContext({
    plugin, baseUrl: 'https://pro.ccode.vip', apiKey: 'sk-test', upstreamTaskId: 'up-42',
  });
  assert.equal(
    resolveTemplate(plugin.provider.poll.url, context),
    'https://pro.ccode.vip/v1/videos/up-42',
  );
  assert.deepEqual(
    resolveTemplate(plugin.provider.poll.headers, context),
    { Authorization: 'Bearer sk-test' },
  );
});

// ===== 出网闸门 =====

test('未申报的主机被拒绝出网', () => {
  const plugin = h3Plugin();
  assert.throws(() => assertUrlAllowed(plugin, 'https://evil.test/v1/videos', '创建请求'), /未在 manifest/);
  assert.throws(() => assertUrlAllowed(plugin, 'https://127.0.0.1/v1/videos', '创建请求'), /内网地址/);
  assert.throws(() => assertUrlAllowed(plugin, 'file:///etc/passwd', '创建请求'), /http\/https/);
  assert.equal(
    assertUrlAllowed(plugin, 'http://pro.ccode.vip/v1/videos', '创建请求'),
    'http://pro.ccode.vip/v1/videos',
  );
});

test('内网地址判定覆盖常见私有网段与元数据地址', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
    assert.equal(isLocallyScopedHost(host), true, `${host} 应判为内网`);
  }
  assert.equal(isLocallyScopedHost('pro.ccode.vip'), false);
});

// ===== 插件包自带的契约用例 =====
//
// 每个插件目录下的 fixtures/ 都在这里跑一遍：给定表单值断言请求体，
// 给定上游响应断言归一化结果。加插件时不用改这个测试。

test('所有已安装插件的 fixtures 全部通过', () => {
  const plugins = registry.listPlugins();
  assert.ok(plugins.length > 0, '至少应有一个已安装插件');
  for (const plugin of plugins) {
    const results = verifyPlugin(plugin);
    for (const result of results) {
      assert.ok(result.ok, `${plugin.id} / ${result.name}: ${result.error}`);
    }
  }
});

test('没有加载失败的插件目录', () => {
  assert.deepEqual(registry.listFailures(), []);
});
