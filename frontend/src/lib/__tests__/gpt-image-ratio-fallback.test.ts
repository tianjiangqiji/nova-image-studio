import { describe, expect, it } from 'vitest';
import {
  getAspectRatioOptions,
  resolveAgentLayout,
  sanitizeLayoutForModel,
} from '@/lib/model-capabilities';

const GPT_PRESET_ID = 'gpt-image-2';

describe('gpt-image-2 用户明确比例在 4K 档不可用时降档保比例', () => {
  it('4K 档比例选项不含 1:1 / 3:4（仅 16:9 / 9:16 / 21:9）', () => {
    const options = getAspectRatioOptions(GPT_PRESET_ID, '4K');
    expect(options.map(option => option.value)).toEqual(['16:9', '9:16', '21:9']);
  });

  it('resolveAgentLayout 用户要 1:1 + 4K 时降档到 2K 并保持 1:1', () => {
    const layout = resolveAgentLayout(GPT_PRESET_ID, {
      requestedAspectRatio: '1:1',
      requestedOutputSize: '4K',
    });
    expect(layout.aspectRatio).toBe('1:1');
    expect(layout.outputSize).toBe('2K');
  });

  it('resolveAgentLayout 用户要 3:4 + 4K 时降档到 2K 并保持 3:4', () => {
    const layout = resolveAgentLayout(GPT_PRESET_ID, {
      requestedAspectRatio: '3:4',
      requestedOutputSize: '4K',
    });
    expect(layout.aspectRatio).toBe('3:4');
    expect(layout.outputSize).toBe('2K');
  });

  it('resolveAgentLayout 用户要 1:1 且档位支持时保持原档', () => {
    const layout = resolveAgentLayout(GPT_PRESET_ID, {
      requestedAspectRatio: '1:1',
      requestedOutputSize: '1K',
    });
    expect(layout.aspectRatio).toBe('1:1');
    expect(layout.outputSize).toBe('1K');
  });

  it('sanitizeLayoutForModel 1:1 + 4K 降档到 2K 保持 1:1', () => {
    const layout = sanitizeLayoutForModel(GPT_PRESET_ID, '4K', '1:1');
    expect(layout).toEqual({ outputSize: '2K', aspectRatio: '1:1' });
  });

  it('sanitizeLayoutForModel 9:16 + 4K 保持 4K/9:16（档位本身支持）', () => {
    const layout = sanitizeLayoutForModel(GPT_PRESET_ID, '4K', '9:16');
    expect(layout).toEqual({ outputSize: '4K', aspectRatio: '9:16' });
  });
});
