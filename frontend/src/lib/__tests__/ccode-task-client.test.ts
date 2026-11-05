import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNovaTask } from '@/lib/ccode-task-client';

afterEach(() => vi.unstubAllGlobals());

describe('createNovaTask', () => {
  it('omits legacy style and preserves upstream model, quality, and separate markup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ taskId: 'task' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      apiKey: 'test-key', baseUrl: 'https://example.test', protocol: 'openai' as const,
      mode: 'image-to-image' as const, prompt: 'edit', model: 'gpt-image-2.6-flare',
      outputSize: 'auto' as const, aspectRatio: 'auto' as const, temperature: 1, parallelCount: 1,
      gptImageStyle: 'natural' as const, gptImageQuality: 'max' as const,
      images: [{ data: 'original', mimeType: 'image/png' }],
      gptImageMarkup: { data: 'overlay', mimeType: 'image/png' },
    };
    await expect(createNovaTask(input)).resolves.toBe('task');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).not.toHaveProperty('gptImageStyle');
    expect(payload).toMatchObject({ model: input.model, gptImageQuality: 'max', images: input.images, gptImageMarkup: input.gptImageMarkup });
    expect(input.gptImageStyle).toBe('natural');
  });
});
