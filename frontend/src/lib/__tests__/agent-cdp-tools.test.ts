import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cdp-client', () => {
  class CdpApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'CdpApiError';
      this.code = code;
    }
  }
  return {
    CdpApiError,
    listCdpTargets: vi.fn(),
    openBrowserTab: vi.fn(),
    readBrowserPage: vi.fn(),
    extractTaobaoProduct: vi.fn(),
    fetchPageImages: vi.fn(),
    getCdpStatus: vi.fn(),
    setCdpPort: vi.fn(),
    launchDebugBrowser: vi.fn(),
    purgeCdpProductImages: vi.fn(),
  };
});

import {
  AGENT_CDP_TOOLS,
  AGENT_CDP_TOOL_NAMES,
  executeAgentCdpTool,
  isAgentCdpTool,
  purgeCdpProductImages,
} from '@/lib/agent-cdp-tools';
import {
  CdpApiError,
  extractTaobaoProduct,
  fetchPageImages,
  getCdpStatus,
  launchDebugBrowser,
  listCdpTargets,
  openBrowserTab,
  purgeCdpProductImages as requestPurgeCdpProductImages,
  readBrowserPage,
  setCdpPort,
} from '@/lib/cdp-client';

const mockedListTargets = vi.mocked(listCdpTargets);
const mockedOpenTab = vi.mocked(openBrowserTab);
const mockedReadPage = vi.mocked(readBrowserPage);
const mockedExtract = vi.mocked(extractTaobaoProduct);
const mockedGetStatus = vi.mocked(getCdpStatus);
const mockedSetPort = vi.mocked(setCdpPort);
const mockedLaunch = vi.mocked(launchDebugBrowser);
const mockedFetchImages = vi.mocked(fetchPageImages);
const mockedPurge = vi.mocked(requestPurgeCdpProductImages);

const SAMPLE_PRODUCT = {
  platform: 'taobao' as const,
  itemId: '123',
  title: '测试商品',
  price: '¥9.9',
  shopName: '测试店铺',
  mainImages: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
  skuProps: [{ name: '颜色', values: ['红', '蓝'] }],
  detailImages: ['https://img.example.com/d1.jpg'],
  url: 'https://item.taobao.com/item.htm?id=123',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetStatus.mockResolvedValue({ reachable: true, port: 9222, browser: 'Edg/151' });
  mockedLaunch.mockResolvedValue({ ok: true, message: '已启动' });
  mockedListTargets.mockResolvedValue([]);
});

describe('AGENT_CDP_TOOLS 工具声明', () => {
  it('声明与工具名清单一一对应', () => {
    expect(AGENT_CDP_TOOLS.map(t => t.name)).toEqual([...AGENT_CDP_TOOL_NAMES]);
    expect(AGENT_CDP_TOOL_NAMES).toContain('browser_read_taobao');
    expect(AGENT_CDP_TOOL_NAMES).not.toContain('browser_read_product');
  });

  it('isAgentCdpTool 识别已声明的工具名（支持有无下划线及大小写容错）', () => {
    expect(isAgentCdpTool('browser_open_url')).toBe(true);
    expect(isAgentCdpTool('browseropenurl')).toBe(true);
    expect(isAgentCdpTool('browserOpenUrl')).toBe(true);
    expect(isAgentCdpTool('browser-open-url')).toBe(true);
    expect(isAgentCdpTool('browserreadtaobao')).toBe(true);
    expect(isAgentCdpTool('propose_image_action')).toBe(false);
  });
});

describe('executeAgentCdpTool', () => {
  it('browser_open_url 成功时返回新标签页 targetId', async () => {
    mockedOpenTab.mockResolvedValue({ targetId: 'T9', url: 'https://example.com/' });
    const result = await executeAgentCdpTool('browser_open_url', { url: 'https://example.com/' });
    expect(mockedOpenTab).toHaveBeenCalledWith('https://example.com/');
    expect(result.text).toContain('targetId=T9');
  });

  it('browser_open_url 复用同 URL 的现有标签页', async () => {
    mockedListTargets.mockResolvedValue([{ id: 'existing-tab', title: 'Example', url: 'https://example.com/' }]);

    const result = await executeAgentCdpTool('browser_open_url', { url: 'https://example.com/' });

    expect(mockedListTargets).toHaveBeenCalled();
    expect(mockedOpenTab).not.toHaveBeenCalled();
    expect(result.text).toContain('targetId=existing-tab');
  });

  it('browser_read_page 返回标题、URL 与正文', async () => {
    mockedReadPage.mockResolvedValue({ title: '标题', url: 'https://example.com/', text: '正文内容' });
    const result = await executeAgentCdpTool('browser_read_page', { targetId: 'T1', maxChars: 5000 });
    expect(mockedReadPage).toHaveBeenCalledWith('T1', 5000);
    expect(result.text).toContain('正文内容');
  });

  it('browser_read_taobao 格式化商品信息并自动抓取主图', async () => {
    mockedExtract.mockResolvedValue(SAMPLE_PRODUCT);
    mockedFetchImages
      .mockResolvedValueOnce([{ url: 'https://img.example.com/1.jpg', localUrl: '/api/nova/cdp/products/a.jpg' }])
      .mockResolvedValueOnce([{ url: 'https://img.example.com/2.jpg', localUrl: '/api/nova/cdp/products/b.jpg' }]);
    const result = await executeAgentCdpTool('browser_read_taobao', { targetId: 'T1' });
    expect(mockedFetchImages).toHaveBeenCalledTimes(SAMPLE_PRODUCT.mainImages.length);
    expect(mockedFetchImages).toHaveBeenNthCalledWith(1, 'T1', [SAMPLE_PRODUCT.mainImages[0]]);
    expect(mockedFetchImages).toHaveBeenNthCalledWith(2, 'T1', [SAMPLE_PRODUCT.mainImages[1]]);
    expect(result.localUrls).toEqual([
      '/api/nova/cdp/products/a.jpg',
      '/api/nova/cdp/products/b.jpg',
    ]);
    expect(result.sourceKey).toBe(SAMPLE_PRODUCT.url);
    expect(result.text).toContain('测试商品');
    // 用户要求提示词不带价格：提炼结果不把价格喂给模型
    expect(result.text).not.toContain('¥9.9');
    expect(result.text).not.toContain('价格');
    expect(result.text).toContain('颜色（红/蓝）');
    expect(result.text).toContain('已自动抓取 2 张主图');
  });

  it('browser_save_images 必须带 urls', async () => {
    const result = await executeAgentCdpTool('browser_save_images', { targetId: 'T1' });
    expect(result.text).toContain('缺少 urls');
    expect(mockedFetchImages).not.toHaveBeenCalled();
  });

  it('browser_save_images 按 maxCount 截断抓取', async () => {
    mockedFetchImages.mockResolvedValue([{ url: 'u1', localUrl: '/api/nova/cdp/image/1' }]);
    const result = await executeAgentCdpTool('browser_save_images', {
      targetId: 'T1',
      urls: ['u1', 'u2', 'u3'],
      maxCount: 1,
    });
    expect(mockedFetchImages).toHaveBeenCalledWith('T1', ['u1']);
    expect(result.localUrls).toEqual(['/api/nova/cdp/image/1']);
  });

  it('底层抛 CdpApiError 时转成错误文本', async () => {
    mockedListTargets.mockRejectedValue(new CdpApiError('浏览器不可达', 'CDP_UNREACHABLE'));
    const result = await executeAgentCdpTool('browser_list_tabs', {});
    expect(result.text).toContain('浏览器不可达');
  });

  it('executeAgentCdpTool 支持无下划线名称如 browseropenurl 执行', async () => {
    mockedOpenTab.mockResolvedValue({ targetId: 'T-NoUnderline', url: 'https://detail.tmall.com/item.htm?id=123' });
    const result = await executeAgentCdpTool('browseropenurl', { url: 'https://detail.tmall.com/item.htm?id=123' });
    expect(mockedOpenTab).toHaveBeenCalledWith('https://detail.tmall.com/item.htm?id=123');
    expect(result.text).toContain('targetId=T-NoUnderline');
    expect(result.text).toContain('browser_read_taobao');
  });

  it('browser_read_taobao 传入商品 URL 时自动先打开页面并提炼', async () => {
    mockedOpenTab.mockResolvedValue({ targetId: 'T-AutoOpened', url: 'https://detail.tmall.com/item.htm?id=999' });
    mockedExtract.mockResolvedValue(SAMPLE_PRODUCT);
    mockedFetchImages.mockResolvedValue([]);
    const result = await executeAgentCdpTool('browser_read_taobao', { targetId: 'https://detail.tmall.com/item.htm?id=999' });
    expect(mockedOpenTab).toHaveBeenCalledWith('https://detail.tmall.com/item.htm?id=999');
    expect(mockedExtract).toHaveBeenCalledWith('T-AutoOpened');
    expect(result.text).toContain(SAMPLE_PRODUCT.title);
  });

  it('purgeCdpProductImages 只提交 CDP 落盘路径', async () => {
    mockedPurge.mockResolvedValue(1);
    const deleted = await purgeCdpProductImages([
      '/api/nova/cdp/products/p_aaaaaaaaaaaaaaaa_1.jpg',
      'https://img.alicdn.com/bao/uploaded/i1.jpg',
    ]);
    expect(mockedPurge).toHaveBeenCalledWith(['/api/nova/cdp/products/p_aaaaaaaaaaaaaaaa_1.jpg']);
    expect(deleted).toBe(1);
  });
});
