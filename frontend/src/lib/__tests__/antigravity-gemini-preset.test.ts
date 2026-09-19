import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationParamsBar } from '@/components/GenerationParamsBar';
import {
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getSupportsTemperature,
  getValidOutputSizes,
  isRetryLayoutCompatible,
  PARALLEL_COUNT_VALUES,
  supportsCustomSize,
} from '@/lib/model-capabilities';
import {
  BUILTIN_IMAGE_PRESETS,
  BUILTIN_IMAGE_PRESET_OPTIONS,
  DEFAULT_DEFAULTS,
  saveRegistry,
  type ImageModelConfig,
} from '@/lib/nova-models';

describe('Antigravity Gemini builtin preset', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('exposes an openai protocol preset pointed at the Antigravity gateway', () => {
    const preset = BUILTIN_IMAGE_PRESETS['antigravity-gemini-image'];

    expect(preset).toBeDefined();
    expect(preset.protocol).toBe('openai');
    expect(preset.modelId).toBe('gemini-3-pro-image-preview');
    expect(preset.baseUrl).toBe('');
    expect(preset.supportsAdvancedParams).toBe(false);
    expect(preset.maxOutputSize).toBe('4K');
    expect(preset.maxRefImages).toBeGreaterThan(0);

    expect(BUILTIN_IMAGE_PRESET_OPTIONS.some(option => option.value === 'antigravity-gemini-image')).toBe(true);
    expect(BUILTIN_IMAGE_PRESET_OPTIONS.find(option => option.value === 'antigravity-gemini-image')?.label).toMatch(/Antigravity/i);
  });

  it('reuses Banana Pro size and aspect options for the Antigravity preset id', () => {
    expect(getValidOutputSizes('antigravity-gemini-image')).toEqual(['1K', '2K', '4K']);
    const ratios = getAspectRatioOptions('antigravity-gemini-image', '1K');
    expect(ratios.map(option => option.value)).toContain('3:4');
    expect(ratios.map(option => option.value)).not.toContain('auto');
  });

  it('accepts 1K/2K/4K retry layouts and is not a custom-size GPT Image model', () => {
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '1K', '1:1')).toBe(true);
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '2K', '3:4')).toBe(true);
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '4K', '16:9')).toBe(true);
    expect(isRetryLayoutCompatible('antigravity-gemini-image', '512', '1:1')).toBe(false);
    expect(supportsCustomSize('antigravity-gemini-image')).toBe(false);
    expect(getSupportsTemperature('antigravity-gemini-image')).toBe(false);
  });

  it('does not enable custom size even when the openai 4K preset is registered', () => {
    const config: ImageModelConfig = {
      ...BUILTIN_IMAGE_PRESETS['antigravity-gemini-image'],
      id: 'antigravity-gemini-image',
      apiKey: 'test-key',
    };
    saveRegistry({
      imageModels: [config],
      textModels: [],
      defaults: DEFAULT_DEFAULTS,
    });
    expect(supportsCustomSize('antigravity-gemini-image')).toBe(false);
    expect(getCustomSizeMaxSide('antigravity-gemini-image')).toBeUndefined();
  });
});
