import { describe, expect, it } from 'vitest';
import { backfillProductScopes } from '@/lib/agent-context-store';
import type { AgentImageRecord, AgentMessage } from '@/lib/agent-chat-config';

function image(imgId: string, description: string): AgentImageRecord {
  return {
    imgId,
    source: 'uploaded',
    thumbnail: `data:image/png;base64,${imgId}`,
    description,
    mimeType: 'image/png',
    createdAt: Number(imgId.replace(/\D/g, '')),
  };
}

describe('backfillProductScopes', () => {
  it('从旧抓图消息恢复商品标题、链接和同组图片', () => {
    const messages: AgentMessage[] = [{
      id: 'm1',
      role: 'assistant',
      text: '✓ 已从浏览器抓取商品《眼线印章》 3 张图并登记：img_11、img_12、img_13（来源：https://item.taobao.com/item.htm?id=123）',
      createdAt: 100,
    }];
    const images = [
      image('img_11', '商品《眼线印章》的图'),
      image('img_12', '商品《眼线印章》的图'),
      image('img_13', '商品《眼线印章》的图'),
      image('img_20', '其他图片'),
    ];

    const result = backfillProductScopes(messages, images);

    expect(result.changedIds).toEqual(['img_11', 'img_12', 'img_13']);
    expect(result.images.slice(0, 3).map(item => ({
      id: item.imgId,
      key: item.productKey,
      name: item.productName,
    }))).toEqual([
      { id: 'img_11', key: 'taobao:123', name: '眼线印章' },
      { id: 'img_12', key: 'taobao:123', name: '眼线印章' },
      { id: 'img_13', key: 'taobao:123', name: '眼线印章' },
    ]);
    expect(result.images[3].productKey).toBeUndefined();
  });

  it('保留新记录已有的商品作用域，不被旧消息覆盖', () => {
    const messages: AgentMessage[] = [{
      id: 'm1',
      role: 'assistant',
      text: '✓ 已从浏览器抓取商品《旧标题》 1 张图并登记：img_1（来源：https://old.example/item）',
      createdAt: 100,
    }];
    const images = [{
      ...image('img_1', '新标题'),
      productKey: 'https://new.example/item',
      productName: '新标题',
    }];

    const result = backfillProductScopes(messages, images);

    expect(result.changedIds).toEqual([]);
    expect(result.images[0].productKey).toBe('https://new.example/item');
    expect(result.images[0].productName).toBe('新标题');
  });
});
