import { describe, expect, it } from 'vitest';
import { normalizeProductKey, scopeAgentProposal } from '@/lib/agent-chat-config';
import type { AgentImageRecord, AgentProposal } from '@/lib/agent-chat-config';

function image(imgId: string, productKey: string): AgentImageRecord {
  return {
    imgId,
    source: 'uploaded',
    thumbnail: `data:image/png;base64,${imgId}`,
    description: '商品图',
    mimeType: 'image/png',
    productKey,
    createdAt: 1,
  };
}

function proposal(overrides: Partial<AgentProposal>): AgentProposal {
  return {
    action: 'generate',
    prompt: '商品宣传图',
    referencedImageIds: [],
    reason: '',
    ...overrides,
  };
}

describe('normalizeProductKey', () => {
  it('淘宝商品链接归一到 item id，忽略 mi_id/spm 等追踪参数', () => {
    expect(normalizeProductKey('https://item.taobao.com/item.htm?id=893737826198&mi_id=abc&spm=x&xxc=shop'))
      .toBe('taobao:893737826198');
    expect(normalizeProductKey('https://item.taobao.com/item.htm?id=893737826198'))
      .toBe('taobao:893737826198');
  });

  it('非商品页链接归一到 origin+pathname，忽略查询串', () => {
    expect(normalizeProductKey('https://example.com/a/b?x=1&y=2')).toBe('https://example.com/a/b');
  });

  it('空值返回 undefined', () => {
    expect(normalizeProductKey('')).toBeUndefined();
    expect(normalizeProductKey(undefined)).toBeUndefined();
  });

  it('已归一的 taobao: 短键幂等，不会二次变形', () => {
    expect(normalizeProductKey('taobao:893737826198')).toBe('taobao:893737826198');
  });
});

describe('scopeAgentProposal 商品键归一化', () => {
  it('提案写短链接、图片记录带完整追踪参数时仍能匹配到同一商品', () => {
    const images = [
      image('img_11', 'https://item.taobao.com/item.htm?id=893737826198&mi_id=abc&spm=x'),
      image('img_12', 'https://item.taobao.com/item.htm?id=893737826198&mi_id=abc&spm=x'),
      image('img_1', 'https://item.taobao.com/item.htm?id=910655306721&mi_id=zzz'),
    ];
    const p = proposal({
      productKey: 'https://item.taobao.com/item.htm?id=893737826198',
      referencedImageIds: ['img_11', 'img_1'],
    });

    const scoped = scopeAgentProposal(p, images);

    expect(scoped.productKey).toBe('taobao:893737826198');
    expect(scoped.referencedImageIds).toEqual(['img_11']);
  });

  it('图片记录存的是 taobao: 短键、提案带完整链接时仍能匹配', () => {
    const images = [
      image('img_11', 'taobao:893737826198'),
      image('img_12', 'taobao:893737826198'),
      image('img_1', 'taobao:910655306721'),
    ];
    const p = proposal({
      productKey: 'https://item.taobao.com/item.htm?id=893737826198&mi_id=abc',
      referencedImageIds: ['img_11', 'img_1'],
    });

    const scoped = scopeAgentProposal(p, images);

    expect(scoped.productKey).toBe('taobao:893737826198');
    expect(scoped.referencedImageIds).toEqual(['img_11']);
  });
});
