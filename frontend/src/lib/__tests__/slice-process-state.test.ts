import { describe, expect, it } from 'vitest';

import {
  applySvgResult,
  applyTransparencyResult,
  clearProcessResults,
  describeProcessResetMessage,
  hasAnyProcessResult,
  isProcessOpActive,
  listActiveProcessOps,
  restoreProcessOp,
} from '@/lib/slice-process-state';
import type { SliceAsset } from '@/lib/slice-types';

function makeAsset(overrides: Partial<SliceAsset> = {}): SliceAsset {
  return {
    id: 'a1',
    name: 'icon_home',
    type: 'icon',
    placement: { x: 0, y: 0, width: 48, height: 48 },
    radius: 0,
    transparent: false,
    aiTransparent: false,
    aiCompleted: false,
    hidden: false,
    originalBlobKey: 'orig',
    currentBlobKey: 'orig',
    ...overrides,
  };
}

describe('isProcessOpActive', () => {
  it('reports nothing active on a fresh asset', () => {
    const asset = makeAsset();
    expect(isProcessOpActive(asset, 'transparent')).toBe(false);
    expect(isProcessOpActive(asset, 'aiTransparent')).toBe(false);
    expect(isProcessOpActive(asset, 'svg')).toBe(false);
    expect(isProcessOpActive(asset, 'aiSvg')).toBe(false);
  });

  it('distinguishes algorithmic transparency from AI transparency', () => {
    const local = makeAsset({ transparent: true, aiTransparent: false });
    expect(isProcessOpActive(local, 'transparent')).toBe(true);
    expect(isProcessOpActive(local, 'aiTransparent')).toBe(false);

    // AI 透明也置 transparent=true，但不能同时点亮算法版
    const ai = makeAsset({ transparent: true, aiTransparent: true });
    expect(isProcessOpActive(ai, 'transparent')).toBe(false);
    expect(isProcessOpActive(ai, 'aiTransparent')).toBe(true);
  });

  it('distinguishes algorithmic SVG from AI SVG', () => {
    const local = makeAsset({ svgData: '<svg/>', svgFromAi: false });
    expect(isProcessOpActive(local, 'svg')).toBe(true);
    expect(isProcessOpActive(local, 'aiSvg')).toBe(false);

    const ai = makeAsset({ svgData: '<svg/>', svgFromAi: true });
    expect(isProcessOpActive(ai, 'svg')).toBe(false);
    expect(isProcessOpActive(ai, 'aiSvg')).toBe(true);
  });
});

describe('applyTransparencyResult', () => {
  it('switches currentBlobKey and records the pre-op snapshot', () => {
    const next = applyTransparencyResult(makeAsset(), { blobKey: 'trans', ai: false });
    expect(next.currentBlobKey).toBe('trans');
    expect(next.transparentBlobKey).toBe('trans');
    expect(next.transparent).toBe(true);
    expect(next.aiTransparent).toBe(false);
    expect(next.processSnapshots?.transparent?.currentBlobKey).toBe('orig');
  });

  it('writes the AI key and flag on the AI variant', () => {
    const next = applyTransparencyResult(makeAsset(), { blobKey: 'ai', ai: true });
    expect(next.aiTransparentBlobKey).toBe('ai');
    expect(next.transparentBlobKey).toBeUndefined();
    expect(next.aiTransparent).toBe(true);
    expect(next.processSnapshots?.aiTransparent).toBeDefined();
  });

  it('clears svgData because bitmap and vector cannot both be current', () => {
    const withSvg = makeAsset({ svgData: '<svg/>', svgFromAi: true });
    const next = applyTransparencyResult(withSvg, { blobKey: 'trans', ai: false });
    expect(next.svgData).toBeNull();
    // 被清掉的 svg 进了快照，还原时会回来
    expect(next.processSnapshots?.transparent?.svgData).toBe('<svg/>');
    expect(next.processSnapshots?.transparent?.svgFromAi).toBe(true);
  });
});

describe('applySvgResult', () => {
  it('keeps currentBlobKey untouched so the canvas still has a bitmap', () => {
    const next = applySvgResult(makeAsset(), { svgData: '<svg><path/></svg>', ai: false });
    expect(next.currentBlobKey).toBe('orig');
    expect(next.svgData).toBe('<svg><path/></svg>');
    expect(next.svgFromAi).toBe(false);
  });

  it('marks AI provenance separately', () => {
    const next = applySvgResult(makeAsset(), { svgData: '<svg/>', ai: true });
    expect(next.svgFromAi).toBe(true);
    expect(next.processSnapshots?.aiSvg).toBeDefined();
  });
});

describe('restoreProcessOp', () => {
  it('returns null when that op has no snapshot', () => {
    expect(restoreProcessOp(makeAsset(), 'transparent')).toBeNull();
  });

  it('round-trips a single op back to the pre-op state', () => {
    const before = makeAsset();
    const after = applyTransparencyResult(before, { blobKey: 'trans', ai: false });
    const restored = restoreProcessOp(after, 'transparent');
    expect(restored).not.toBeNull();
    expect(restored!.currentBlobKey).toBe('orig');
    expect(restored!.transparent).toBe(false);
    expect(restored!.transparentBlobKey).toBeNull();
    expect(restored!.processSnapshots).toBeNull();
  });

  it('keeps the four ops independently reversible', () => {
    // 这是本次改动的核心：上游算法版与 AI 版共用一个还原槽，
    // 会出现「做了 AI 透明后，算法 SVG 的还原点被顶掉」。
    let asset = applySvgResult(makeAsset(), { svgData: '<svg id="local"/>', ai: false });
    asset = applyTransparencyResult(asset, { blobKey: 'ai-trans', ai: true });

    expect(isProcessOpActive(asset, 'aiTransparent')).toBe(true);
    // 透明化清掉了 svgData
    expect(asset.svgData).toBeNull();

    // 还原 AI 透明 → 算法 SVG 应该回来，且它自己的还原点仍在
    const afterRestore = restoreProcessOp(asset, 'aiTransparent');
    expect(afterRestore!.svgData).toBe('<svg id="local"/>');
    expect(isProcessOpActive(afterRestore!, 'svg')).toBe(true);
    expect(afterRestore!.processSnapshots?.svg).toBeDefined();

    // 再还原算法 SVG → 彻底回到起点
    const clean = restoreProcessOp(afterRestore!, 'svg');
    expect(clean!.svgData).toBeNull();
    expect(clean!.processSnapshots).toBeNull();
  });

  it('does not disturb the other op snapshot when restoring one', () => {
    let asset = applyTransparencyResult(makeAsset(), { blobKey: 'trans', ai: false });
    asset = applySvgResult(asset, { svgData: '<svg/>', ai: true });
    const restored = restoreProcessOp(asset, 'aiSvg');
    expect(restored!.processSnapshots?.transparent).toBeDefined();
    expect(isProcessOpActive(restored!, 'transparent')).toBe(true);
  });
});

describe('hasAnyProcessResult / listActiveProcessOps', () => {
  it('is false on a fresh asset', () => {
    expect(hasAnyProcessResult(makeAsset())).toBe(false);
    expect(listActiveProcessOps(makeAsset())).toEqual([]);
  });

  it('lists active ops in a stable order', () => {
    const asset = makeAsset({ transparent: true, svgData: '<svg/>', svgFromAi: false });
    expect(listActiveProcessOps(asset)).toEqual(['transparent', 'svg']);
  });
});

describe('describeProcessResetMessage', () => {
  it('names every affected op so the user knows what they would lose', () => {
    const asset = makeAsset({ name: 'hero_bg', transparent: true, aiTransparent: true, svgData: null });
    const message = describeProcessResetMessage(asset);
    expect(message).toContain('hero_bg');
    expect(message).toContain('AI 透明');
  });

  it('combines multiple ops into one sentence', () => {
    const asset = makeAsset({ transparent: true, svgData: '<svg/>', svgFromAi: true });
    const message = describeProcessResetMessage(asset);
    expect(message).toContain('透明');
    expect(message).toContain('AI SVG');
  });

  it('falls back to a plain recrop notice when nothing is applied', () => {
    expect(describeProcessResetMessage(makeAsset())).toContain('重新裁剪');
  });
});

describe('clearProcessResults', () => {
  it('drops every processed flag, key, and snapshot', () => {
    let asset = applyTransparencyResult(makeAsset(), { blobKey: 'trans', ai: true });
    asset = applySvgResult(asset, { svgData: '<svg/>', ai: false });
    const cleared = clearProcessResults(asset);
    expect(cleared.transparent).toBe(false);
    expect(cleared.aiTransparent).toBe(false);
    expect(cleared.transparentBlobKey).toBeNull();
    expect(cleared.aiTransparentBlobKey).toBeNull();
    expect(cleared.svgData).toBeNull();
    expect(cleared.svgFromAi).toBe(false);
    expect(cleared.processSnapshots).toBeNull();
    expect(hasAnyProcessResult(cleared)).toBe(false);
  });
});
