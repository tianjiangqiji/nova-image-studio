// Agent 浏览器工具：通用读页 + 淘宝页提炼。执行结果喂给模型；抓图额外返回 localUrls。

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
  type CdpStatus,
  type TaobaoProduct,
} from '@/lib/cdp-client';

export interface AgentCdpToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const AGENT_CDP_TOOL_NAMES = [
  'browser_status',
  'browser_set_port',
  'browser_list_tabs',
  'browser_open_url',
  'browser_read_page',
  'browser_read_taobao',
  'browser_save_images',
] as const;

export const AGENT_CDP_TOOLS: AgentCdpToolDef[] = [
  {
    name: 'browser_status',
    description: '探测本机调试浏览器是否已连接。未连接时会自动启动一个独立调试浏览器。返回当前端口和浏览器版本。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_set_port',
    description: '把后端连接的 CDP 调试端口改成用户指定的端口，例如 9224。',
    parameters: {
      type: 'object',
      properties: { port: { type: 'integer', description: '本机浏览器远程调试端口' } },
      required: ['port'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_list_tabs',
    description: '列出调试浏览器当前打开的标签页，返回 targetId、标题和 URL。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_open_url',
    description: '在调试浏览器中打开指定 URL，返回 targetId。未连接时会先自动启动调试浏览器。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http/https URL' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_read_page',
    description: '读取任意标签页的正文文本，返回标题、URL 和正文。适合一般网页。',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: '标签页 id' },
        maxChars: { type: 'integer', description: '正文字符上限，默认 8000' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_read_taobao',
    description: '仅用于淘宝/天猫商品页：提炼标题、店铺、SKU、主图链接、详情图链接，并自动抓取主图登记为会话图片（img_N，可直接用于提案的 referenced_image_ids）。不要对非商品页调用。',
    parameters: {
      type: 'object',
      properties: { targetId: { type: 'string', description: '商品页标签页 id' } },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_save_images',
    description: '把指定图片 URL 抓到本地图片目录。urls 来自 browser_read_taobao 的主图/详情图，或页面里看到的图片地址。',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: '打开该图片所在页的标签页 id' },
        urls: { type: 'array', items: { type: 'string' }, description: '要抓取的图片 URL 列表' },
        maxCount: { type: 'integer', description: '最多抓取数量，默认 5，上限 10' },
      },
      required: ['targetId', 'urls'],
      additionalProperties: false,
    },
  },
];

export interface AgentCdpToolResult {
  text: string;
  localUrls?: string[];
  /** 稳定的商品作用域键，优先使用商品页面 URL */
  sourceKey?: string;
  /** 抓图来源（商品标题 / 页面 URL）：登记进图片目录和会话历史时带上，模型才能分清哪些图属于哪个商品 */
  sourceTitle?: string;
  sourceUrl?: string;
}

export function normalizeCdpToolName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  const canonical = trimmed.toLowerCase().replace(/[-_]/g, '');
  for (const toolName of AGENT_CDP_TOOL_NAMES) {
    if (toolName.replace(/_/g, '').toLowerCase() === canonical) {
      return toolName;
    }
  }
  return trimmed;
}

export function isAgentCdpTool(name: string): boolean {
  const normalized = normalizeCdpToolName(name);
  return (AGENT_CDP_TOOL_NAMES as readonly string[]).includes(normalized as typeof AGENT_CDP_TOOL_NAMES[number]);
}

export async function purgeCdpProductImages(files: string[]): Promise<number> {
  const urls = files.filter(item => typeof item === 'string' && item.includes('/api/nova/cdp/products/'));
  if (urls.length === 0) return 0;
  try {
    return await requestPurgeCdpProductImages(urls);
  } catch {
    return 0;
  }
}

async function ensureDebugBrowser(): Promise<{ ok: true; status: CdpStatus; launched: boolean } | { ok: false; text: string }> {
  const current = await getCdpStatus();
  if (current.reachable) return { ok: true, status: current, launched: false };
  const launch = await launchDebugBrowser();
  if (!launch.ok) return { ok: false, text: `调试浏览器未连接，自动启动失败：${launch.message}` };
  const after = await getCdpStatus();
  if (!after.reachable) return { ok: false, text: `已尝试启动调试浏览器，但端口仍不可达。${launch.message}` };
  return { ok: true, status: after, launched: true };
}

function formatConnected(status: CdpStatus, launched: boolean): string {
  const prefix = launched ? '已自动启动调试浏览器并连接' : '调试浏览器已连接';
  return `${prefix}。端口=${status.port ?? '未知'}，浏览器=${status.browser || '未知'} ${status.version || ''}`.trim();
}

export async function executeAgentCdpTool(
  rawName: string,
  args: Record<string, unknown>,
  onProgress?: (text: string) => void,
): Promise<AgentCdpToolResult> {
  const name = normalizeCdpToolName(rawName);
  try {
    switch (name) {
      case 'browser_status': {
        const ensured = await ensureDebugBrowser();
        if (!ensured.ok) return { text: ensured.text };
        return { text: formatConnected(ensured.status, ensured.launched) };
      }
      case 'browser_set_port': {
        const port = typeof args.port === 'number' && Number.isFinite(args.port) ? Math.round(args.port) : 0;
        if (port < 1 || port > 65535) return { text: '参数错误：port 必须是 1-65535 的整数。' };
        onProgress?.(`正在切换到调试端口 ${port}…`);
        const status = await setCdpPort(port);
        if (status.reachable) {
          return { text: `已切换到端口 ${status.port}，调试浏览器已连接（${status.browser || '浏览器'}）。` };
        }
        const launch = await launchDebugBrowser();
        const after = await getCdpStatus();
        if (after.reachable) return { text: `已切换到端口 ${after.port}，并自动启动调试浏览器。` };
        return { text: `已把 CDP 端口改成 ${status.port}，但该端口连不上。自动启动结果：${launch.message}` };
      }
      case 'browser_list_tabs': {
        const ensured = await ensureDebugBrowser();
        if (!ensured.ok) return { text: ensured.text };
        const targets = await listCdpTargets();
        const prefix = ensured.launched ? `${formatConnected(ensured.status, true)}\n` : '';
        if (targets.length === 0) return { text: `${prefix}浏览器当前没有打开任何标签页。` };
        const lines = targets.map(t => `- targetId=${t.id}｜${t.title || '(无标题)'}｜${t.url}`);
        return { text: `${prefix}当前共 ${targets.length} 个标签页：\n${lines.join('\n')}` };
      }
      case 'browser_open_url': {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) return { text: '参数错误：缺少 url。' };
        const ensured = await ensureDebugBrowser();
        if (!ensured.ok) return { text: ensured.text };
        onProgress?.(`正在打开页面…`);
        try {
          const existingTargets = await listCdpTargets();
          const existing = Array.isArray(existingTargets) ? existingTargets.find(target => target.url === url) : undefined;
          if (existing) {
            const prefix = ensured.launched ? `${formatConnected(ensured.status, true)}\n` : '';
            const isTaobao = /taobao\.com|tmall\.com/i.test(url);
            const guide = isTaobao ? `\n提示：该页面为淘宝/天猫商品页，请调用 browser_read_taobao(targetId="${existing.id}") 提炼商品核心信息与主图。` : '';
            return { text: `${prefix}已复用现有标签页。targetId=${existing.id}\nURL：${existing.url}${guide}` };
          }
        } catch {
          // 列举标签页失败时保持原有打开路径
        }
        const target = await openBrowserTab(url);
        const prefix = ensured.launched ? `${formatConnected(ensured.status, true)}\n` : '';
        const isTaobao = /taobao\.com|tmall\.com/i.test(url);
        const guide = isTaobao ? `\n提示：该页面为淘宝/天猫商品页，请调用 browser_read_taobao(targetId="${target.targetId}") 提炼商品核心信息与主图。` : '';
        return { text: `${prefix}已打开标签页。targetId=${target.targetId}\nURL：${target.url}${guide}` };
      }
      case 'browser_read_page': {
        let targetId = typeof args.targetId === 'string' ? args.targetId.trim() : '';
        const urlCandidate = typeof args.url === 'string' ? args.url.trim() : '';
        if (!targetId && urlCandidate && /^https?:\/\//i.test(urlCandidate)) {
          targetId = urlCandidate;
        }
        if (/^https?:\/\//i.test(targetId)) {
          const ensured = await ensureDebugBrowser();
          if (!ensured.ok) return { text: ensured.text };
          onProgress?.('检测到网页链接，正在打开标签页…');
          try {
            const existingTargets = await listCdpTargets();
            const existing = Array.isArray(existingTargets) ? existingTargets.find(t => t.url === targetId) : undefined;
            if (existing) {
              targetId = existing.id;
            } else {
              const opened = await openBrowserTab(targetId);
              targetId = opened.targetId;
            }
          } catch (err) {
            return { text: `打开页面失败：${err instanceof Error ? err.message : String(err)}` };
          }
        }
        if (!targetId) return { text: '参数错误：缺少 targetId。' };
        const ensured = await ensureDebugBrowser();
        if (!ensured.ok) return { text: ensured.text };
        const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? Math.round(args.maxChars) : undefined;
        onProgress?.('正在读取页面正文…');
        const page = await readBrowserPage(targetId, maxChars);
        const text = page.text.trim().length > 0 ? page.text : '(页面正文为空，可能仍在加载，可稍后重试)';
        return { text: `页面标题：${page.title}\n页面 URL：${page.url}\n正文内容：\n${text}` };
      }
      case 'browser_read_taobao': {
        let targetId = typeof args.targetId === 'string' ? args.targetId.trim() : '';
        const urlCandidate = typeof args.url === 'string' ? args.url.trim() : '';
        // 容错：若模型直接把商品 url 传给 targetId 或作为 url 参数传入，自动打开标签页并提炼
        if (!targetId && urlCandidate && /^https?:\/\//i.test(urlCandidate)) {
          targetId = urlCandidate;
        }
        if (/^https?:\/\//i.test(targetId)) {
          const ensured = await ensureDebugBrowser();
          if (!ensured.ok) return { text: ensured.text };
          onProgress?.('检测到商品链接，正在打开商品页面…');
          try {
            const existingTargets = await listCdpTargets();
            const existing = Array.isArray(existingTargets) ? existingTargets.find(t => t.url === targetId) : undefined;
            if (existing) {
              targetId = existing.id;
            } else {
              const opened = await openBrowserTab(targetId);
              targetId = opened.targetId;
            }
          } catch (err) {
            return { text: `打开商品页面失败：${err instanceof Error ? err.message : String(err)}` };
          }
        }
        if (!targetId) return { text: '参数错误：缺少 targetId。' };
        const ensured = await ensureDebugBrowser();
        if (!ensured.ok) return { text: ensured.text };
        onProgress?.('正在提炼商品信息…');
        const product = await extractTaobaoProduct(targetId);
        const mainImages = product.mainImages.slice(0, 8);
        let text = formatProductForModel(product);
        if (mainImages.length === 0) return { text };
        onProgress?.(`已提炼商品信息，正在抓取 ${mainImages.length} 张主图…`);
        const results: { url: string; localUrl?: string; error?: string }[] = [];
        for (let i = 0; i < mainImages.length; i += 1) {
          const batch = await fetchPageImages(targetId, [mainImages[i]]);
          results.push(...batch);
          onProgress?.(`主图抓取进度 ${i + 1}/${mainImages.length}`);
        }
        const localUrls = results.filter(r => typeof r.localUrl === 'string').map(r => r.localUrl as string);
        const failures = results.filter(r => typeof r.error === 'string').map(r => r.error as string);
        if (localUrls.length > 0) {
          text += `\n已自动抓取 ${localUrls.length} 张主图`;
          if (failures.length > 0) text += `，另有 ${failures.length} 张失败：${failures.join('；')}`;
          return {
            text,
            localUrls,
            sourceKey: product.url,
            sourceTitle: product.title,
            sourceUrl: product.url,
          };
        }
        if (failures.length > 0) text += `\n主图自动抓取失败：${failures.join('；')}`;
        return { text };
      }
      case 'browser_save_images': {
        const targetId = typeof args.targetId === 'string' ? args.targetId.trim() : '';
        if (!targetId) return { text: '参数错误：缺少 targetId。' };
        const urls = Array.isArray(args.urls)
          ? args.urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
          : [];
        if (urls.length === 0) return { text: '参数错误：缺少 urls。请先用 browser_read_taobao 或 browser_read_page 拿到图片地址。' };
        const ensured = await ensureDebugBrowser();
        if (!ensured.ok) return { text: ensured.text };
        const maxCount = Math.min(10, Math.max(1, typeof args.maxCount === 'number' && Number.isFinite(args.maxCount) ? Math.round(args.maxCount) : 5));
        const targetUrls = urls.slice(0, maxCount);
        onProgress?.(`正在抓取 ${targetUrls.length} 张图片…`);
        const results: { url: string; localUrl?: string; error?: string }[] = [];
        for (let i = 0; i < targetUrls.length; i += 1) {
          const batch = await fetchPageImages(targetId, [targetUrls[i]]);
          results.push(...batch);
          onProgress?.(`图片抓取进度 ${i + 1}/${targetUrls.length}`);
        }
        const localUrls = results.filter(r => typeof r.localUrl === 'string').map(r => r.localUrl as string);
        const failures = results.filter(r => typeof r.error === 'string').map(r => r.error as string);
        if (localUrls.length === 0) return { text: `图片抓取失败：${failures.join('；') || '未知错误'}` };
        let text = `已成功抓取 ${localUrls.length} 张图片`;
        if (failures.length > 0) text += `，另有 ${failures.length} 张失败`;
        // 手动抓图没有商品提炼结果，退而用标签页标题/URL 标记来源；查不到不影响抓图结果
        let sourceTitle: string | undefined;
        let sourceUrl: string | undefined;
        try {
          const tab = (await listCdpTargets()).find(t => t.id === targetId);
          sourceTitle = tab?.title || undefined;
          sourceUrl = tab?.url || undefined;
        } catch { /* 标签页信息不可得时忽略 */ }
        return { text, localUrls, sourceKey: sourceUrl, sourceTitle, sourceUrl };
      }
      default:
        return { text: `未知工具：${name}` };
    }
  } catch (err) {
    const message = err instanceof CdpApiError || err instanceof Error ? err.message : String(err);
    return { text: `工具 ${name} 执行失败：${message}` };
  }
}

function formatProductForModel(product: TaobaoProduct): string {
  const lines = [
    `平台：${product.platform}`,
    `商品标题：${product.title || '(未识别到标题)'}`,
  ];
  if (product.itemId) lines.push(`商品 ID：${product.itemId}`);
  if (product.shopName) lines.push(`店铺：${product.shopName}`);
  lines.push(`页面 URL：${product.url}`);
  if (product.skuProps.length > 0) {
    lines.push(`SKU：${product.skuProps.map(p => `${p.name}（${p.values.join('/')}）`).join('；')}`);
  }
  lines.push(`主图（${product.mainImages.length} 张）：`);
  product.mainImages.forEach((u, i) => lines.push(`  ${i + 1}. ${u}`));
  if (product.detailImages.length > 0) {
    lines.push(`详情图（${product.detailImages.length} 张）：`);
    product.detailImages.slice(0, 20).forEach((u, i) => lines.push(`  ${i + 1}. ${u}`));
  }
  if (product.errors && product.errors.length > 0) lines.push(`提取警告：${product.errors.join('；')}`);
  return lines.join('\n');
}
