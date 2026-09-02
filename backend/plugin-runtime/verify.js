'use strict';

/**
 * 插件包自检 CLI。
 *
 *   node plugin-runtime/verify.js            校验全部已安装插件
 *   node plugin-runtime/verify.js ccode-h3   只校验一个
 *
 * 除了跑结构校验，还会执行插件目录下 fixtures/ 里的「契约用例」：
 * 给定一份表单值，断言拼出来的上游请求体；给定一份上游响应，断言归一化后的结果。
 *
 * 这一步刻意不联网：既能在 CI 里跑，也能在没有密钥的机器上验证协议映射是否写对。
 * 联网只能验证「这次通了」，而 fixtures 验证的是「所有分支都还是当初的样子」。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const registry = require('./registry');
const { resolveTemplate } = require('./template');
const { pickFirstString } = require('./extract');
const { validateAndNormalizeInput } = require('./input');
const { buildContext, normalizePollResponse } = require('./executor');

/** fixtures 里统一使用的占位凭据，避免把真实密钥写进仓库 */
const FIXTURE_BASE_URL = 'https://upstream.test';
const FIXTURE_API_KEY = 'sk-fixture';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFixtureDirs(pluginDir) {
  const root = path.join(pluginDir, 'fixtures');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 断言两个对象深度相等，失败时打出可读的差异 */
function expectDeepEqual(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    throw new Error(
      `${label} 不匹配\n  期望: ${JSON.stringify(expected, null, 2)}\n  实际: ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

function runFixture(plugin, fixture) {
  const input = readJson(path.join(fixture.dir, 'input.json'));
  const normalized = validateAndNormalizeInput(plugin, input);

  const context = buildContext({
    plugin,
    baseUrl: FIXTURE_BASE_URL,
    apiKey: FIXTURE_API_KEY,
    model: normalized.model,
    facets: normalized.facets,
    fields: normalized.fields,
    media: normalized.media,
  });

  // 1. 创建请求
  const expectedRequestPath = path.join(fixture.dir, 'expected-request.json');
  if (fs.existsSync(expectedRequestPath)) {
    const expected = readJson(expectedRequestPath);
    const submit = plugin.provider.submit;
    const actual = {
      method: String(submit.method || 'GET').toUpperCase(),
      url: resolveTemplate(submit.url, context),
      body: submit.body === undefined ? undefined : resolveTemplate(submit.body, context),
    };
    if (expected.model !== undefined) {
      expectDeepEqual(normalized.model, expected.model, '模型 ID');
    }
    if (expected.method !== undefined) expectDeepEqual(actual.method, expected.method, '请求方法');
    if (expected.url !== undefined) expectDeepEqual(actual.url, expected.url, '请求地址');
    if (expected.body !== undefined) expectDeepEqual(actual.body, expected.body, '请求体');
  }

  // 2. 创建响应里的上游任务 ID
  const submitResponsePath = path.join(fixture.dir, 'upstream-submit.json');
  let upstreamTaskId = 'fixture-task';
  if (fs.existsSync(submitResponsePath)) {
    const payload = readJson(submitResponsePath);
    const extracted = pickFirstString(payload, plugin.provider.submit.extract.taskId);
    assert.ok(extracted, '未能从 upstream-submit.json 中取出上游任务 ID');
    upstreamTaskId = extracted;
  }

  // 3. 轮询响应的归一化
  const pollPath = path.join(fixture.dir, 'upstream-poll.json');
  const expectedResultPath = path.join(fixture.dir, 'expected-result.json');
  if (fs.existsSync(pollPath) && fs.existsSync(expectedResultPath)) {
    const payload = readJson(pollPath);
    const expected = readJson(expectedResultPath);
    const pollContext = buildContext({
      plugin,
      baseUrl: FIXTURE_BASE_URL,
      apiKey: FIXTURE_API_KEY,
      model: normalized.model,
      facets: normalized.facets,
      fields: normalized.fields,
      media: normalized.media,
      upstreamTaskId,
    });
    // 走线上同一个函数，fixtures 才真的在验证线上行为
    const actual = normalizePollResponse(plugin, payload, pollContext);
    expectDeepEqual(actual, expected, '归一化结果');
  }
}

function verifyPlugin(plugin) {
  const results = [];
  const fixtures = listFixtureDirs(plugin.dir);
  for (const fixture of fixtures) {
    try {
      runFixture(plugin, fixture);
      results.push({ name: fixture.name, ok: true });
    } catch (error) {
      results.push({ name: fixture.name, ok: false, error: error.message });
    }
  }
  return results;
}

function main() {
  const target = process.argv[2];
  const plugins = registry.listPlugins().filter(plugin => !target || plugin.id === target);
  const failures = registry.listFailures().filter(failure => !target || failure.id === target);

  let failed = 0;

  for (const failure of failures) {
    console.error(`✗ ${failure.id} 加载失败`);
    for (const line of String(failure.error).split('；')) {
      console.error(`    ${line}`);
    }
    failed++;
  }

  if (plugins.length === 0 && failures.length === 0) {
    console.error(target ? `找不到插件 ${target}` : '插件目录里没有任何插件');
    process.exit(1);
  }

  for (const plugin of plugins) {
    console.log(`✓ ${plugin.id}@${plugin.manifest.version} 结构校验通过（${plugin.manifest.models.length} 个模型）`);
    const results = verifyPlugin(plugin);
    if (results.length === 0) {
      console.log('    （没有 fixtures/，跳过契约用例）');
      continue;
    }
    for (const result of results) {
      if (result.ok) {
        console.log(`    ✓ ${result.name}`);
      } else {
        failed++;
        console.error(`    ✗ ${result.name}`);
        for (const line of result.error.split('\n')) console.error(`      ${line}`);
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} 项未通过`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

if (require.main === module) main();

module.exports = { verifyPlugin, runFixture, FIXTURE_BASE_URL, FIXTURE_API_KEY };
