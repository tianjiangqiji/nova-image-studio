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


it('serializes native GIF animation parameters to the backend', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ taskId: 'gif-task' }), { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  await createNovaTask({
    apiKey: 'test-key', baseUrl: 'https://example.test', protocol: 'openai', model: 'gpt-image-2.6-flare',
    mode: 'text-to-image', prompt: 'cat blinks', images: [], parallelCount: 1,
    outputSize: 'auto', aspectRatio: 'auto', temperature: 1,
    gptImageOutputFormat: 'gif', gifFrameCount: 12, gifFrameDurationMs: 80,
  });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
    gptImageOutputFormat: 'gif', gifFrameCount: 12, gifFrameDurationMs: 80, images: [],
  });
});
