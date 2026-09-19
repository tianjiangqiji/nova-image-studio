import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEFAULTS,
  BUILTIN_IMAGE_PRESETS,
  getImageModelOutputSizes,
  loadRegistry,
  saveRegistry,
  type ImageModelConfig,
} from '@/lib/nova-models';
import {
  getAspectRatioOptions,
  getDefaultRetryLayout,
  getSizeOptions,
  getValidOutputSizes,
  isRetryLayoutCompatible,
  resolveAgentLayout,
} from '@/lib/model-capabilities';

const SEEDREAM_PRESET_ID = 'doubao-seedream';

const seedreamConfig: ImageModelConfig = {
  ...BUILTIN_IMAGE_PRESETS[SEEDREAM_PRESET_ID],
  id: 'seedream-configured',
  builtinPreset: SEEDREAM_PRESET_ID,
  apiKey: 'test-key',
};

describe('Seedream 5.0 Lite output sizes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('exposes only 2K and 4K from both model capability entry points', () => {
    expect(getSizeOptions(SEEDREAM_PRESET_ID).map(option => option.value)).toEqual(['2K', '4K']);
    expect(getValidOutputSizes(SEEDREAM_PRESET_ID)).toEqual(['2K', '4K']);

    saveRegistry({
      imageModels: [seedreamConfig],
      textModels: [],
      defaults: DEFAULT_DEFAULTS,
    });
    expect(getSizeOptions(seedreamConfig.id).map(option => option.value)).toEqual(['2K', '4K']);
    expect(getValidOutputSizes(seedreamConfig.id)).toEqual(['2K', '4K']);
  });

  it('normalizes a requested or implicit 1K layout to the actual 2K tier', () => {
    expect(getDefaultRetryLayout(SEEDREAM_PRESET_ID).outputSize).toBe('2K');

    expect(resolveAgentLayout(SEEDREAM_PRESET_ID, {
      requestedOutputSize: '1K',
      requestedAspectRatio: '16:9',
    }).outputSize).toBe('2K');

    expect(resolveAgentLayout(SEEDREAM_PRESET_ID, {
      requestedAspectRatio: '16:9',
    }).outputSize).toBe('2K');
  });

  it('does not treat 1K as retry-compatible for Seedream', () => {
    expect(isRetryLayoutCompatible(SEEDREAM_PRESET_ID, '1K', '1:1')).toBe(false);
    expect(isRetryLayoutCompatible(SEEDREAM_PRESET_ID, '2K', '1:1')).toBe(true);
    expect(isRetryLayoutCompatible(SEEDREAM_PRESET_ID, '4K', '1:1')).toBe(true);
  });

  it('shows the concrete resolution that Seedream receives for each legal tier', () => {
    const size2k = getAspectRatioOptions(SEEDREAM_PRESET_ID, '2K');
    const size4k = getAspectRatioOptions(SEEDREAM_PRESET_ID, '4K');
    const invalidSize = getAspectRatioOptions(SEEDREAM_PRESET_ID, '1K');
    const autoSize = getAspectRatioOptions(SEEDREAM_PRESET_ID, 'auto');

    expect(size2k.find(option => option.value === '1:1')?.resolution).toBe('2048x2048');
    expect(size2k.find(option => option.value === '16:9')?.resolution).toBe('2560x1440');
    expect(size4k.find(option => option.value === '1:1')?.resolution).toBe('3840x3840');
    expect(size4k.find(option => option.value === '16:9')?.resolution).toBe('3840x2160');
    expect(invalidSize.find(option => option.value === '1:1')?.resolution).toBe('2048x2048');
    expect(autoSize.find(option => option.value === '1:1')?.resolution).toBe('2048x2048');
  });

  it('keeps the model registry output-size list aligned with the frontend controls', () => {
    expect(getImageModelOutputSizes(seedreamConfig)).toEqual(['2K', '4K']);
  });

  it('repairs a persisted Seedream 1K maximum before any selector reads it', () => {
    localStorage.setItem('nova-model-registry', JSON.stringify({
      imageModels: [{
        ...seedreamConfig,
        maxOutputSize: '1K',
      }],
      textModels: [],
      defaults: DEFAULT_DEFAULTS,
    }));

    const loaded = loadRegistry().imageModels[0];
    expect(loaded.maxOutputSize).toBe('2K');
    expect(getImageModelOutputSizes(loaded)).toEqual(['2K']);
    expect(getSizeOptions(loaded.id).map(option => option.value)).toEqual(['2K']);
    expect(isRetryLayoutCompatible(loaded.id, '4K', '1:1')).toBe(false);
  });
});

describe('parallelCount 归一化', () => {
  it('支持每商品 5 张（1-8），超出上限钳到 8', () => {
    expect(resolveAgentLayout(SEEDREAM_PRESET_ID, { parallelCount: 5 }).parallelCount).toBe(5);
    expect(resolveAgentLayout(SEEDREAM_PRESET_ID, { parallelCount: 99 }).parallelCount).toBe(8);
  });
});
