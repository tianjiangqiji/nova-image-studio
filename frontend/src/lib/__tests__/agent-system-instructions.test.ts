import { describe, expect, it } from 'vitest';
import { AGENT_CDP_SYSTEM_SUFFIX, AGENT_SYSTEM_INSTRUCTIONS, PROPOSE_IMAGE_ACTION_TOOL } from '@/lib/agent-chat-config';

// 合并上游时的守卫：这条规则是本 fork 修复「多图分别处理被塞进同一提案导致拼接/雷同」的关键，
// 上游没有，merge 时容易被冲掉。
describe('AGENT_SYSTEM_INSTRUCTIONS 多图分别处理规则', () => {
  it('包含「每张图单独提案」规则', () => {
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain('每张图单独调用一次 propose_image_action');
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain('同一轮可以连续调用多次');
  });

  it('parallel_count schema and instructions allow 1-8', () => {
    expect(PROPOSE_IMAGE_ACTION_TOOL.parameters.properties.parallel_count.description).toContain('1-8');
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain('parallel_count：用户要「多出几张/多个方案」时给 2-8');
  });

  it('包含一致性规则：edit/同一产品时禁止重新设计产品与品牌元素', () => {
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain('一致性优先');
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain('禁止重新设计产品');
  });
});

describe('AGENT_CDP_SYSTEM_SUFFIX 商品链接流程', () => {
  it('商品链接生成/重做时先抓取并分析卖点与构图，结论融入提案', () => {
    expect(AGENT_CDP_SYSTEM_SUFFIX).toContain('卖点与构图分析');
    expect(AGENT_CDP_SYSTEM_SUFFIX).toContain('不要直接套通用模板');
  });

  it('商品主图提案要求把卖点写死为具体画面文案', () => {
    expect(AGENT_CDP_SYSTEM_SUFFIX).toContain('写死为具体画面文案');
    expect(AGENT_CDP_SYSTEM_SUFFIX).toContain('主标题');
  });

  it('商品重做图遵循一致性：参考抓回的主图，不重新设计产品', () => {
    expect(AGENT_CDP_SYSTEM_SUFFIX).toContain('遵循一致性规则');
  });

  it('指令不引用价格：分析明确不涉及价格', () => {
    expect(AGENT_CDP_SYSTEM_SUFFIX).toContain('不涉及价格');
    expect(AGENT_CDP_SYSTEM_SUFFIX).not.toContain('、价格');
    expect(AGENT_CDP_SYSTEM_SUFFIX).not.toContain('价格、');
  });
});
