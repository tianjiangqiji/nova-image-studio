import { describe, expect, it } from 'vitest';

import {
  CONTEXT_LIMIT_TOKENS,
  CONTEXT_REFUSE_TOKENS,
  CONTEXT_WARN_TOKENS,
  contextLevel,
  contextRatio,
  describeUsage,
  formatTokens,
} from '@/lib/web-agent/context';

describe('contextLevel', () => {
  it('三档阈值的边界', () => {
    expect(contextLevel(0)).toBe('ok');
    expect(contextLevel(CONTEXT_WARN_TOKENS - 1)).toBe('ok');
    expect(contextLevel(CONTEXT_WARN_TOKENS)).toBe('warn');
    expect(contextLevel(CONTEXT_REFUSE_TOKENS - 1)).toBe('warn');
    expect(contextLevel(CONTEXT_REFUSE_TOKENS)).toBe('blocked');
    expect(contextLevel(CONTEXT_LIMIT_TOKENS * 2)).toBe('blocked');
  });

  // 首轮请求前没有任何 usage。这时必须放行，否则用户永远发不出第一条消息。
  it('尚无用量数据时视为 ok', () => {
    expect(contextLevel(null)).toBe('ok');
    expect(contextLevel(undefined)).toBe('ok');
    expect(contextLevel(Number.NaN)).toBe('ok');
  });
});

describe('formatTokens', () => {
  // 用 — 而不是 0：首轮前确实不知道，拿 0 冒充是假精确。
  it('无数据显示破折号', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
  });

  it('千位以下显示原值，以上显示 K', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(10_321)).toBe('10.3K');
    expect(formatTokens(175_000)).toBe('175.0K');
  });
});

describe('contextRatio', () => {
  it('归一化到 [0,1] 并对超限夹紧', () => {
    expect(contextRatio(null)).toBe(0);
    expect(contextRatio(CONTEXT_LIMIT_TOKENS / 2)).toBeCloseTo(0.5);
    expect(contextRatio(CONTEXT_LIMIT_TOKENS * 3)).toBe(1);
  });
});

describe('describeUsage', () => {
  it('无数据时给出明确说明', () => {
    expect(describeUsage(null)).toBe('尚未收到用量数据');
  });

  it('只在有值时才列出缓存与推理', () => {
    const bare = describeUsage({ inputTokens: 10_321, outputTokens: 366, totalTokens: 10_687 });
    expect(bare).toContain('输入 10.3K');
    expect(bare).not.toContain('缓存');
    expect(bare).not.toContain('推理');

    const full = describeUsage({
      inputTokens: 10_321,
      outputTokens: 366,
      totalTokens: 10_687,
      cachedTokens: 8_192,
      reasoningTokens: 13,
    });
    expect(full).toContain('缓存命中 8.2K');
    expect(full).toContain('推理 13');
  });
});
