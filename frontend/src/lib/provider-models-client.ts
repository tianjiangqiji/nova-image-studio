import { parseUpstreamModelList } from '@/lib/provider-registry';

export async function fetchUpstreamModels(input: {
  baseUrl: string;
  apiKey: string;
  protocol: string;
}): Promise<string[]> {
  const response = await fetch('/api/nova/proxy/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      apiKey: input.apiKey,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(readProxyError(detail, response.status));
  }
  return parseUpstreamModelList(await response.json());
}

function readProxyError(detail: string, status: number): string {
  const fallback = `读取模型列表失败（${status}）`;
  const raw = String(detail || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error === 'object' && typeof (parsed.error as { message?: unknown }).message === 'string') {
      return String((parsed.error as { message: string }).message);
    }
  } catch {
    if (!raw.startsWith('<')) return raw.slice(0, 180);
  }
  return fallback;
}
