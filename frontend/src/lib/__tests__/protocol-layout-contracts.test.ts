import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSizeOptions,
  getSupportsTemperature,
  getValidOutputSizes,
  isRetryLayoutCompatible,
  supportsAutoLayout,
  supportsCustomSize,
} from '@/lib/model-capabilities';
import {
  BUILTIN_IMAGE_PRESETS,
  DEFAULT_DEFAULTS,
  isSliceCapableImageModel,
  saveRegistry,
  type ImageModelConfig,
} from '@/lib/nova-models';

function registered(presetId: keyof typeof BUILTIN_IMAGE_PRESETS, id = presetId): ImageModelConfig {
  return {
    ...BUILTIN_IMAGE_PRESETS[presetId],
    id,
    apiKey: 'test-key',
  };
}

describe('protocol layout contracts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('treats only real GPT Image openai models as slice-capable', () => {
    expect(isSliceCapableImageModel(registered('gpt-image-2'))).toBe(true);
    expect(isSliceCapableImageModel(registered('antigravity-gemini-image'))).toBe(false);
    expect(isSliceCapableImageModel({
      ...registered('gpt-image-2', 'custom-openai-gemini'),
      builtinPreset: 'gpt-image-2',
      modelId: 'gemini-3-pro-image-preview',
    })).toBe(false);
    expect(isSliceCapableImageModel(registered('gemini-3-pro-image-preview'))).toBe(false);
    expect(isSliceCapableImageModel(registered('grok-imagine-image-edit'))).toBe(false);
  });

  it('does not enable auto layout for Gemini or Grok even if preset is gpt-image-2', () => {
    expect(supportsAutoLayout('gpt-image-2')).toBe(true);
    expect(supportsAutoLayout('antigravity-gemini-image')).toBe(false);
    expect(supportsAutoLayout('grok-imagine-image')).toBe(false);
    expect(supportsAutoLayout('gemini-3.1-flash-image-preview')).toBe(false);

    saveRegistry({
      imageModels: [{
        ...registered('gpt-image-2', 'mislabelled-gemini'),
        builtinPreset: 'gpt-image-2',
        modelId: 'gemini-3.1-flash-image',
      }],
      textModels: [],
      defaults: DEFAULT_DEFAULTS,
    });
    expect(supportsAutoLayout('mislabelled-gemini')).toBe(false);
  });

  it('does not give Antigravity Gemini GPT custom-size support', () => {
    expect(supportsCustomSize('antigravity-gemini-image')).toBe(false);
    saveRegistry({
      imageModels: [registered('antigravity-gemini-image'), registered('gpt-image-2')],
      textModels: [],
      defaults: DEFAULT_DEFAULTS,
    });
    expect(supportsCustomSize('antigravity-gemini-image')).toBe(false);
    expect(supportsCustomSize('gpt-image-2')).toBe(true);
  });

  it('accepts Antigravity 1K/2K/4K and Alibaba sizes from getValidOutputSizes', () => {
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '1K', '1:1')).toBe(true);
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '2K', '3:4')).toBe(true);
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '4K', '16:9')).toBe(true);

    expect(getValidOutputSizes('alibaba-qwen-image')).toEqual(expect.arrayContaining(['2K']));
    expect(getValidOutputSizes('alibaba-wan-image')).toEqual(expect.arrayContaining(['2K']));
    expect(isRetryLayoutCompatible('alibaba-qwen-image', '2K', '1:1')).toBe(true);
    expect(isRetryLayoutCompatible('alibaba-wan-image', '2K', '1:1')).toBe(true);

    saveRegistry({
      imageModels: [registered('alibaba-qwen-image'), registered('alibaba-wan-image')],
      textModels: [],
      defaults: DEFAULT_DEFAULTS,
    });
    expect(getValidOutputSizes('alibaba-qwen-image')).toContain('2K');
    expect(isRetryLayoutCompatible('alibaba-qwen-image', '2K', '1:1')).toBe(true);
    expect(isRetryLayoutCompatible('alibaba-wan-image', '2K', '1:1')).toBe(true);
    expect(isRetryLayoutCompatible('alibaba-qwen-image', '4K', '1:1')).toBe(false);
  });

  it('disables temperature for grok, seedream, dashscope and antigravity gemini', () => {
    expect(getSupportsTemperature('grok-imagine-image')).toBe(false);
    expect(getSupportsTemperature('grok-imagine-image-edit')).toBe(false);
    expect(getSupportsTemperature('doubao-seedream')).toBe(false);
    expect(getSupportsTemperature('alibaba-qwen-image')).toBe(false);
    expect(getSupportsTemperature('alibaba-wan-image')).toBe(false);
    expect(getSupportsTemperature('antigravity-gemini-image')).toBe(false);
    expect(getSupportsTemperature('gemini-3-pro-image-preview')).toBe(true);
  });

  it('caps Grok Imagine Edit at 3 reference images', () => {
    expect(BUILTIN_IMAGE_PRESETS['grok-imagine-image-edit'].maxRefImages).toBe(3);
  });

  it('keeps Gemini 3.1 Flash sizes at 1K/2K/4K without 512', () => {
    expect(getSizeOptions('gemini-3.1-flash-image-preview').map(option => option.value)).toEqual(['1K', '2K', '4K']);
    expect(getValidOutputSizes('gemini-3.1-flash-image-preview')).not.toContain('512');
  });
});
