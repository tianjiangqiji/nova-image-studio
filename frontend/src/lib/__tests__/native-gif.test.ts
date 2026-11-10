import { describe, expect, it } from 'vitest';
import { getNativeGifParamsError, normalizeNativeGifParams } from '@/lib/native-gif';

describe('native GIF parameters', () => {
  it('uses official defaults for absent settings and migrates previously saved 20-frame settings', () => {
    expect(normalizeNativeGifParams(undefined, undefined)).toEqual({ gifFrameCount: 9, gifFrameDurationMs: 200 });
    expect(normalizeNativeGifParams(20, 80)).toEqual({ gifFrameCount: 9, gifFrameDurationMs: 80 });
  });

  it.each([[2, 20], [16, 2000], [9, 25]])('accepts valid bounds and timing before API rounding: %i frames, %i ms', (count, duration) => {
    expect(getNativeGifParamsError(count, duration)).toBeUndefined();
  });

  it('preserves valid stored values and rounds timing to the nearest 10 milliseconds', () => {
    expect(normalizeNativeGifParams(12, 24)).toEqual({ gifFrameCount: 12, gifFrameDurationMs: 20 });
    expect(normalizeNativeGifParams(12, 25)).toEqual({ gifFrameCount: 12, gifFrameDurationMs: 30 });
  });

  it.each([1, 17, 2.5, Number.NaN, '9'])('reports an invalid frame count: %s', count => {
    expect(getNativeGifParamsError(count, 200)).toContain('2–16');
  });

  it.each([19, 2001, 20.5, Number.NaN, '200'])('reports invalid frame timing: %s', duration => {
    expect(getNativeGifParamsError(9, duration)).toContain('20–2000');
  });
});
