import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpstreamModels } from '@/lib/provider-models-client';

describe('fetchUpstreamModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs credentials in the JSON body instead of the query string', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/nova/proxy/models');
      expect(init?.method).toBe('POST');
      expect(String(input)).not.toContain('apiKey');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.apiKey).toBe('test-key');
      expect(body.baseUrl).toBe('https://example.test');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchUpstreamModels({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      protocol: 'openai',
    })).resolves.toEqual(['gpt-4o-mini']);
  });

  it('surfaces JSON error.message instead of dumping the raw payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401 },
    )));
    await expect(fetchUpstreamModels({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      protocol: 'openai',
    })).rejects.toThrow('invalid api key');
  });
});
