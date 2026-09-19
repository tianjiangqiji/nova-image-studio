// Agent 浏览器工具的前端封装：同源请求后端 /api/nova/cdp/*。

export interface CdpStatus {
  reachable: boolean;
  browser?: string;
  version?: string;
  host?: string;
  port?: number;
}

export interface CdpTarget {
  id: string;
  title: string;
  url: string;
}

export interface TaobaoProduct {
  platform: 'taobao' | 'tmall' | 'unknown';
  itemId?: string;
  title: string;
  price?: string;
  shopName?: string;
  mainImages: string[];
  skuProps: { name: string; values: string[] }[];
  detailImages: string[];
  url: string;
  errors?: string[];
}

export interface FetchImageResult {
  url: string;
  localUrl?: string;
  error?: string;
}

export class CdpApiError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'CdpApiError';
    this.code = code;
  }
}

const STATUS_TIMEOUT = 10000;
const EXTRACT_TIMEOUT = 30000;
const IMAGE_TIMEOUT = 60000;

interface CdpErrorBody {
  error?: unknown;
  code?: unknown;
}

async function parseCdpResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (typeof data === 'object' && data !== null ? data : {}) as CdpErrorBody;
    let message = typeof body.error === 'string' ? body.error : '';
    if (!message && response.status === 404) {
      message = '浏览器自动化服务未启用（请在 backend/.env 中配置 NOVA_CDP_ENABLED=true 并重启服务）';
    }
    message = message || `HTTP ${response.status}`;
    const code = typeof body.code === 'string' ? body.code : undefined;
    throw new CdpApiError(message, code);
  }
  return data as T;
}

async function postCdp<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseCdpResponse<T>(response);
}

export async function getCdpStatus(): Promise<CdpStatus> {
  const response = await fetch('/api/nova/cdp/status', {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(STATUS_TIMEOUT),
  });
  return parseCdpResponse<CdpStatus>(response);
}

export async function setCdpPort(port: number): Promise<CdpStatus> {
  return postCdp<CdpStatus>('/api/nova/cdp/config', { port }, STATUS_TIMEOUT);
}

export async function listCdpTargets(): Promise<CdpTarget[]> {
  const response = await fetch('/api/nova/cdp/targets', {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(STATUS_TIMEOUT),
  });
  const data = await parseCdpResponse<{ targets?: CdpTarget[] }>(response);
  return Array.isArray(data?.targets) ? data.targets : [];
}

export async function extractTaobaoProduct(targetId: string): Promise<TaobaoProduct> {
  const data = await postCdp<{ product?: TaobaoProduct }>(
    '/api/nova/cdp/extract',
    { targetId },
    EXTRACT_TIMEOUT,
  );
  if (!data?.product) throw new CdpApiError('后端未返回商品信息');
  return data.product;
}

export async function fetchPageImages(targetId: string, urls: string[]): Promise<FetchImageResult[]> {
  const data = await postCdp<{ results?: FetchImageResult[] }>(
    '/api/nova/cdp/fetch-image',
    { targetId, urls },
    IMAGE_TIMEOUT,
  );
  return Array.isArray(data?.results) ? data.results : [];
}

export async function purgeCdpProductImages(files: string[]): Promise<number> {
  if (files.length === 0) return 0;
  const data = await postCdp<{ deleted?: number }>('/api/nova/cdp/purge-images', { files }, STATUS_TIMEOUT);
  return typeof data.deleted === 'number' ? data.deleted : 0;
}

export async function launchDebugBrowser(): Promise<{ ok: boolean; message: string }> {
  return postCdp<{ ok: boolean; message: string }>('/api/nova/cdp/launch', {}, EXTRACT_TIMEOUT);
}

export async function openBrowserTab(url: string): Promise<{ targetId: string; url: string }> {
  const data = await postCdp<{ targetId?: string; url?: string }>(
    '/api/nova/cdp/open',
    { url },
    EXTRACT_TIMEOUT,
  );
  if (!data?.targetId) throw new CdpApiError('后端未返回标签页 id');
  return { targetId: data.targetId, url: typeof data.url === 'string' ? data.url : url };
}

export async function readBrowserPage(targetId: string, maxChars?: number): Promise<{ title: string; url: string; text: string }> {
  const data = await postCdp<{ title?: string; url?: string; text?: string }>(
    '/api/nova/cdp/read-page',
    { targetId, maxChars },
    EXTRACT_TIMEOUT,
  );
  return {
    title: typeof data?.title === 'string' ? data.title : '',
    url: typeof data?.url === 'string' ? data.url : '',
    text: typeof data?.text === 'string' ? data.text : '',
  };
}
