import { beforeEach, describe, expect, it } from 'vitest';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import type { StoredJob } from '@/lib/job-store';
import {
  getCompatibleRetryData,
  getGptImageAdvancedParamsForModel,
  getGptImageQualityOptions,
  getModelMaxRefImages,
  supportsGptImageMarkup,
  supportsNativeImageOutput,
} from '@/lib/model-capabilities';
import { BUILTIN_IMAGE_PRESETS, loadRegistry, saveRegistry, type ImageModelConfig } from '@/lib/nova-models';
import { inferImagePreset } from '@/lib/provider-registry';

function config(id: string, modelId: string, protocol: ImageModelConfig['protocol'] = 'openai'): ImageModelConfig {
  return { id, modelId, protocol, name: id, apiKey: 'test-key', baseUrl: `https://${protocol}.example.test`,
    builtinPreset: protocol === 'openai' ? 'gpt-image-2' : 'gemini-3-pro-image-preview',
    maxRefImages: 16, maxOutputSize: '4K', supportsAdvancedParams: true };
}

beforeEach(() => {
  localStorage.clear();
  saveRegistry({
    imageModels: [
      config('custom-25', 'gpt-image-2.5-flare'),
      config('custom-26', 'gpt-image-2.6-sunburst'),
      config('gpt-image-2.6-flare', 'gpt-image-2'),
      config('other-protocol', 'gemini-3-pro-image-preview', 'google'),
    ],
    textModels: [],
    defaults: { textToImage: 'custom-26', imageToImage: 'custom-26', reversePrompt: '', agent: '',
      promptOptimize: '', layoutSpec: '', imageDescribe: '', sliceDecomposition: '', sliceReconstruct: '', sliceImageEdit: '' },
  });
  syncDynamicModelExports();
});

describe('standard GPT Image capabilities', () => {
  it('recognizes native formats by the configured upstream ID and protocol', () => {
    expect(supportsNativeImageOutput('custom-26')).toBe(true);
    expect(supportsNativeImageOutput('custom-25')).toBe(false);
    expect(supportsNativeImageOutput('gpt-image-2.6-flare')).toBe(false);
    expect(supportsNativeImageOutput('other-protocol')).toBe(false);
  });

  it('provides 2.6 templates while preserving user provider settings', () => {
    expect(BUILTIN_IMAGE_PRESETS['gpt-image-2.6'].modelId).toBe('gpt-image-2.6-flare');
    expect(BUILTIN_IMAGE_PRESETS['gpt-image-2.6-pro'].modelId).toBe('gpt-image-2.6-sunburst-pro');
    expect(inferImagePreset('openai-compatible', 'gpt-image-2.6-sunburst')).toBe('gpt-image-2.6');
    expect(inferImagePreset('openai-compatible', 'gpt-image-2.6-flare-pro-tokens')).toBe('gpt-image-2.6-pro');
    expect(loadRegistry().imageModels.find(model => model.id === 'custom-26')).toMatchObject({
      modelId: 'gpt-image-2.6-sunburst', baseUrl: 'https://openai.example.test', apiKey: 'test-key',
    });
  });

  it('restores custom sizes and SVG output even outside preset aspect ratios', () => {
    const job: StoredJob = {
      id: 'svg', mode: 'text-to-image', status: 'completed', prompt: 'vector icon', model: 'custom-26',
      created_at: '', output_size: '4K', aspect_ratio: '1:1', custom_size: '3264x2448', temperature: 1,
      gptImageOutputFormat: 'svg',
    };
    expect(getCompatibleRetryData(job)).toMatchObject({ customSize: '3264x2448', gptImageOutputFormat: 'svg' });
  });

  it.each(['custom-25', 'custom-26'])('enables all six qualities and markup from upstream ID for %s', model => {
    expect(getGptImageQualityOptions(model).map(option => option.value).sort())
      .toEqual(['auto', 'high', 'low', 'max', 'medium', 'xhigh']);
    expect(supportsGptImageMarkup(model)).toBe(true);
    expect(getModelMaxRefImages(model)).toBe(16);
    expect(getGptImageAdvancedParamsForModel(model, { quality: 'max', style: 'vivid' }))
      .toEqual({ quality: 'max', style: 'auto', background: 'auto' });
  });

  it.each(['gpt-image-2.6-flare', 'other-protocol'])('uses the actual upstream family for %s', model => {
    expect(supportsGptImageMarkup(model)).toBe(false);
    expect(getGptImageQualityOptions(model)).toHaveLength(4);
    expect(getGptImageAdvancedParamsForModel(model, { quality: 'xhigh' }).quality).toBe('auto');
  });

  it('restores markup and full quality only when still bound to the first reference', () => {
    const job: StoredJob = {
      id: 'failed', mode: 'image-to-image', status: 'failed', prompt: 'edit the marked area',
      model: 'custom-26', created_at: '2026-11-05T00:00:00Z', output_size: '1K', aspect_ratio: '1:1',
      temperature: 1, gptImageQuality: 'xhigh',
      refImages: [{ id: 'first', name: 'first.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,original' }],
      gptImageMarkup: { referenceId: 'first', dataUrl: 'data:image/png;base64,overlay' },
    };
    expect(getCompatibleRetryData(job)).toMatchObject({ gptImageQuality: 'xhigh', gptImageMarkup: job.gptImageMarkup });
    expect(getCompatibleRetryData({ ...job, gptImageMarkup: { ...job.gptImageMarkup!, referenceId: 'other' } }).gptImageMarkup)
      .toBeUndefined();
    expect(getCompatibleRetryData({ ...job, model: 'gpt-image-2.6-flare' }).gptImageMarkup).toBeUndefined();
  });
});
