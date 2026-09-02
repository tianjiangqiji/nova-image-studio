import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  availableFacetValues,
  buildScope,
  checkSubmittable,
  coerceFacets,
  coerceFieldValues,
  defaultFacets,
  defaultFieldValues,
  estimateCost,
  facetsFromModel,
  isFieldRequired,
  isFieldVisible,
  matchCondition,
  resolveMaxCount,
  resolveModel,
  resolvedMediaFields,
  toolbarEntries,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
  type PluginUiSchema,
} from '@/lib/plugin-schema';

/**
 * 直接读随仓库分发的 ccode-h3 插件包，而不是在测试里另写一份 schema。
 * 这样插件包和宿主求解器一旦走偏，测试立刻会红——那正是最容易出问题的地方。
 */
function loadH3(): InstalledPlugin {
  const dir = path.resolve(process.cwd(), '..', 'backend', 'plugins', 'ccode-h3');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const uiSchema = JSON.parse(readFileSync(path.join(dir, 'ui.schema.json'), 'utf8')) as PluginUiSchema;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description,
    author: manifest.author ?? '',
    homepage: manifest.homepage ?? '',
    outputs: manifest.outputs,
    credential: manifest.credential,
    media: manifest.media,
    models: manifest.models.map((model: Record<string, unknown>) => ({
      id: model.id,
      name: model.name,
      shortName: model.shortName ?? model.name,
      description: model.description ?? '',
      price: model.price ?? null,
    })),
    uiSchema,
  } as InstalledPlugin;
}

const plugin = loadH3();
const schema = plugin.uiSchema;

describe('条件求值', () => {
  it('所有键都要命中，键内任一命中即可', () => {
    expect(matchCondition({ mode: ['a'] }, { mode: 'a' })).toBe(true);
    expect(matchCondition({ mode: ['a', 'b'] }, { mode: 'b' })).toBe(true);
    expect(matchCondition({ mode: ['a'], tier: ['x'] }, { mode: 'a', tier: 'y' })).toBe(false);
    expect(matchCondition(undefined, {})).toBe(true);
  });

  it('比较按字符串进行，数字与数字字符串等价', () => {
    expect(matchCondition({ seconds: [4] }, { seconds: '4' })).toBe(true);
  });
});

describe('facet 与模型', () => {
  it('默认取每个 facet 的第一个可用值', () => {
    expect(defaultFacets(schema)).toEqual({ tier: 'standard', resolution: '768P' });
  });

  it('组合反解模型，不存在的组合返回 null', () => {
    expect(resolveModel(schema, { tier: 'standard', resolution: '4K' })).toBe('minimax-h3-original-cf-4k');
    expect(resolveModel(schema, { tier: 'lite', resolution: '768P' })).toBe('minimax-h3-quantized-768p');
    expect(resolveModel(schema, { tier: 'comic', resolution: '1080P' })).toBeNull();
  });

  it('可选分辨率随档位收窄', () => {
    expect(availableFacetValues(schema, 'resolution', { tier: 'standard', resolution: '768P' }))
      .toEqual(['768P', '1080P', '2K', '4K']);
    // 漫画版没有 1080P
    expect(availableFacetValues(schema, 'resolution', { tier: 'comic', resolution: '768P' }))
      .toEqual(['768P', '2K', '4K']);
    expect(availableFacetValues(schema, 'resolution', { tier: 'lite', resolution: '768P' }))
      .toEqual(['768P']);
  });

  it('切档位后把不存在的分辨率收敛回最低档', () => {
    // 原版 1080P → 漫画版：1080P 不存在，落回 768P
    expect(coerceFacets(schema, { tier: 'comic', resolution: '1080P' }))
      .toEqual({ tier: 'comic', resolution: '768P' });
    // 2K 两个档位都有，应当保留
    expect(coerceFacets(schema, { tier: 'comic', resolution: '2K' }))
      .toEqual({ tier: 'comic', resolution: '2K' });
  });

  it('由模型反查 facet，供历史记录重用参数', () => {
    expect(facetsFromModel(schema, 'minimax-h3-comic-cf-4k')).toEqual({ tier: 'comic', resolution: '4K' });
    expect(facetsFromModel(schema, 'not-a-model')).toBeNull();
  });
});

describe('字段默认值与收敛', () => {
  const facets: FacetValues = { tier: 'standard', resolution: '768P' };

  it('默认值取 schema 申报的 default', () => {
    const fields = defaultFieldValues(schema, facets);
    expect(fields.mode).toBe('multi-reference');
    expect(fields.aspectRatio).toBe('9:16');
    expect(fields.seconds).toBe(4);
    expect(fields.prompt).toBe('');
  });

  it('切到量化版时首尾帧模式被收敛回全能参考', () => {
    const before: FieldValues = { mode: 'first-last-frame', aspectRatio: '9:16', seconds: 8, prompt: 'p' };
    const after = coerceFieldValues(schema, { tier: 'lite', resolution: '768P' }, before);
    expect(after.mode).toBe('multi-reference');
    // 与档位无关的字段不动
    expect(after.seconds).toBe(8);
  });

  it('档位支持时保留原有模式', () => {
    const before: FieldValues = { mode: 'first-last-frame', aspectRatio: '9:16', seconds: 8, prompt: 'p' };
    const after = coerceFieldValues(schema, { tier: 'comic', resolution: '768P' }, before);
    expect(after.mode).toBe('first-last-frame');
  });
});

describe('素材槽', () => {
  const multi: FieldValues = { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: 'p' };
  const fl2v: FieldValues = { mode: 'first-last-frame', aspectRatio: '9:16', seconds: 8, prompt: 'p' };

  it('全能参考模式显示图片 / 视频 / 音频三个槽', () => {
    const slots = resolvedMediaFields(schema, { tier: 'standard', resolution: '768P' }, multi);
    expect(slots.map(slot => slot.field.key)).toEqual(['multiImage', 'multiVideo', 'multiAudio']);
    expect(slots.map(slot => slot.maxCount)).toEqual([9, 3, 3]);
  });

  it('量化版只剩参考图，且名额收紧到 4', () => {
    const slots = resolvedMediaFields(schema, { tier: 'lite', resolution: '768P' }, multi);
    expect(slots.map(slot => slot.field.key)).toEqual(['multiImage']);
    expect(slots[0].maxCount).toBe(4);
  });

  it('首尾帧模式只剩首帧与尾帧，首帧必填', () => {
    const slots = resolvedMediaFields(schema, { tier: 'standard', resolution: '768P' }, fl2v);
    expect(slots.map(slot => slot.field.key)).toEqual(['firstFrame', 'lastFrame']);
    expect(slots[0].required).toBe(true);
    expect(slots[1].required).toBe(false);
  });

  it('2K / 4K 让参考图从可选变必填', () => {
    const at768 = resolvedMediaFields(schema, { tier: 'standard', resolution: '768P' }, multi);
    expect(at768[0].required).toBe(false);
    const at2k = resolvedMediaFields(schema, { tier: 'standard', resolution: '2K' }, multi);
    expect(at2k[0].required).toBe(true);
  });

  it('maxCount 的 byFacet 映射缺省时落到 default', () => {
    const videoField = schema.fields.find(field => field.key === 'multiVideo')!;
    expect(resolveMaxCount(videoField, { tier: 'standard' })).toBe(3);
    expect(resolveMaxCount(videoField, { tier: 'lite' })).toBe(0);
  });

  it('字段可见性同时受 facet 与其它字段影响', () => {
    const firstFrame = schema.fields.find(field => field.key === 'firstFrame')!;
    expect(isFieldVisible(firstFrame, buildScope({ tier: 'standard' }, fl2v))).toBe(true);
    expect(isFieldVisible(firstFrame, buildScope({ tier: 'standard' }, multi))).toBe(false);
    const multiImage = schema.fields.find(field => field.key === 'multiImage')!;
    expect(isFieldRequired(multiImage, buildScope({ resolution: '4K' }, multi))).toBe(true);
    expect(isFieldRequired(multiImage, buildScope({ resolution: '1080P' }, multi))).toBe(false);
  });
});

describe('提交校验', () => {
  const facets: FacetValues = { tier: 'standard', resolution: '768P' };
  const fields: FieldValues = { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: '一只猫' };

  it('齐全时可提交', () => {
    expect(checkSubmittable(schema, facets, fields, {})).toEqual({ ok: true, reason: null });
  });

  it('提示词为空时给出可读原因', () => {
    const result = checkSubmittable(schema, facets, { ...fields, prompt: '  ' }, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('提示词');
  });

  it('超分档位缺参考图时不可提交', () => {
    const result = checkSubmittable(schema, { tier: 'standard', resolution: '2K' }, fields, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('参考图片');
    expect(checkSubmittable(schema, { tier: 'standard', resolution: '2K' }, fields, { multiImage: 1 }).ok).toBe(true);
  });

  it('不存在的组合不可提交', () => {
    expect(checkSubmittable(schema, { tier: 'comic', resolution: '1080P' }, fields, {}).ok).toBe(false);
  });

  it('超出名额不可提交', () => {
    const result = checkSubmittable(schema, { tier: 'lite', resolution: '768P' }, fields, { multiImage: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('最多 4');
  });
});

describe('计价与布局', () => {
  it('按秒计费时数量取 priceQuantityField', () => {
    expect(estimateCost(plugin, 'minimax-h3-original-768p', { seconds: 10 })).toBe(1.5);
    expect(estimateCost(plugin, 'minimax-h3-quantized-768p', { seconds: 4 })).toBe(0.32);
  });

  it('数量缺失或模型未申报价格时返回 null，而不是 0', () => {
    expect(estimateCost(plugin, 'minimax-h3-original-768p', {})).toBeNull();
    expect(estimateCost(plugin, 'unknown-model', { seconds: 4 })).toBeNull();
  });

  it('工具栏顺序来自 layout.toolbar', () => {
    expect(toolbarEntries(schema)).toEqual(['$model', 'mode', '$resolution', 'aspectRatio', 'seconds']);
  });
});
