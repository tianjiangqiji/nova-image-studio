import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGifWorkflow, type SubmitInput } from '@/hooks/useGifWorkflow';
import { createNovaTask, type NovaTaskResponse } from '@/lib/ccode-task-client';
import { novaTaskSocket } from '@/lib/ccode-task-socket';
import { loadGifTemplate, saveActiveGifJob } from '@/lib/gif-job-store';
import { resolveImagePayloadToBlob } from '@/lib/image-actions';
import { encodeGifFromGrid } from '@/lib/gif-encoder';
import { inspectNativeGif } from '@/lib/native-gif';

vi.mock('@/lib/ccode-task-client', () => ({ createNovaTask: vi.fn().mockResolvedValue('server-1'), ackNovaTask: vi.fn(), getNovaTask: vi.fn(), resolveImageTaskProvider: vi.fn((modelId: string) => ({ apiKey: 'test-key', baseUrl: 'https://custom.example.test', protocol: 'openai', modelId })) }));
vi.mock('@/lib/ccode-task-socket', () => ({ novaTaskSocket: { subscribeTask: vi.fn(() => vi.fn()) } }));
vi.mock('@/lib/settings-storage', () => ({ getApiKeyFromStorage: () => 'test-key' }));
vi.mock('@/lib/image-actions', () => ({ resolveImagePayloadToBlob: vi.fn() }));
vi.mock('@/lib/image-downloader', () => ({
  downloadAndStoreImages: vi.fn().mockResolvedValue({ successCount: 1, blobUrls: ['blob:result'] }),
  resolveStoredImageRef: vi.fn().mockResolvedValue({ image: 'blob:restored', blobUrl: 'blob:restored' }),
  makeStoredBlobRef: (id: string) => `IDB:${id}-0`, revokeBlobUrls: vi.fn(), deleteStoredBlobs: vi.fn(),
}));
vi.mock('@/lib/gif-job-store', async original => ({
  ...await original<typeof import('@/lib/gif-job-store')>(),
  loadGifTemplate: vi.fn().mockResolvedValue({ data: 'template', mimeType: 'image/png' }),
}));
vi.mock('@/lib/gif-encoder', () => ({ encodeGifFromGrid: vi.fn(), encodeFramesToGif: vi.fn(), triggerGifDownload: vi.fn() }));

const GIF = 'R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7';
const gifBlob = new NodeBlob([Buffer.from(GIF, 'base64')], { type: 'image/gif' }) as unknown as Blob;
const input: SubmitInput = {
  prompt: '红球跳动', loop: true, closedLoop: true, model: 'gpt-image-2.6-flare',
  gptImageQuality: 'auto', gptImageStyle: 'auto', gptImageBackground: 'auto',
  refImages: [], frameDelayMs: 120, loopCount: 0, framePadding: 1.5,
};
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.mocked(resolveImagePayloadToBlob).mockResolvedValue(gifBlob); });
afterEach(cleanup);

async function complete() {
  const callback = vi.mocked(novaTaskSocket.subscribeTask).mock.calls.at(-1)![1];
  await act(async () => callback({ id: 'server-1', status: 'completed', result: { images: ['URL:/api/result'] } } as NovaTaskResponse));
}

describe('native GIF workflow', () => {
  it('defaults 2.6 to native mode, skips the template and directly preserves animated GIF bytes', async () => {
    const { result } = renderHook(useGifWorkflow);
    await act(async () => result.current.submitGrid(input));
    expect(loadGifTemplate).not.toHaveBeenCalled();
    expect(createNovaTask).toHaveBeenCalledWith(expect.objectContaining({ mode: 'text-to-image', gptImageOutputFormat: 'gif', gifFrameCount: 20, gifFrameDurationMs: 200, outputSize: 'auto', images: [], baseUrl: 'https://custom.example.test', protocol: 'openai', model: input.model }));
    await complete();
    await waitFor(() => expect(result.current.job?.resultFrameCount).toBe(2));
    expect(result.current.job?.status).toBe('done');
    expect(result.current.gifBlob).toBe(gifBlob);
    expect(result.current.job?.warning).toBeUndefined();
    await act(async () => result.current.encodeGif(input));
    expect(encodeGifFromGrid).not.toHaveBeenCalled();
  });

  it('preserves custom timing in requests, persisted jobs and retry inputs', async () => {
    const custom = { ...input, gifFrameCount: 24, gifFrameDurationMs: 80 };
    const first = renderHook(useGifWorkflow);
    await act(async () => first.result.current.submitGrid(custom));
    await complete();
    first.unmount();
    const restored = renderHook(useGifWorkflow);
    await waitFor(() => expect(restored.result.current.job).toMatchObject({ gifFrameCount: 24, gifFrameDurationMs: 80 }));
    await act(async () => restored.result.current.submitGrid({ ...input, ...restored.result.current.job! }));
    expect(createNovaTask).toHaveBeenLastCalledWith(expect.objectContaining({ gifFrameCount: 24, gifFrameDurationMs: 80, gptImageOutputFormat: 'gif' }));
  });

  it('ignores retained grid references and only sends text in native mode', async () => {
    const { result } = renderHook(useGifWorkflow);
    await act(async () => result.current.submitGrid({ ...input, refImages: [{ id: 'r1', name: 'ref.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,abc' }] }));
    expect(createNovaTask).toHaveBeenCalledWith(expect.objectContaining({ mode: 'text-to-image', images: [] }));
    expect(result.current.job?.refImages).toEqual([]);
    expect(loadGifTemplate).not.toHaveBeenCalled();
  });

  it.each([{ model: 'gpt-image-2.6-flare', nativeGif: false }, { model: 'gpt-image-2-pro', nativeGif: true }])('keeps manual grid generation for %j', async overrides => {
    const { result } = renderHook(useGifWorkflow);
    await act(async () => result.current.submitGrid({ ...input, gifFrameCount: 24, gifFrameDurationMs: 80, ...overrides }));
    expect(loadGifTemplate).toHaveBeenCalledOnce();
    expect(vi.mocked(createNovaTask).mock.calls.at(-1)![0]).not.toHaveProperty('gifFrameCount');
    expect(vi.mocked(createNovaTask).mock.calls.at(-1)![0]).not.toHaveProperty('gifFrameDurationMs');
    expect(createNovaTask).toHaveBeenCalledWith(expect.objectContaining({ gptImageOutputFormat: 'png', customSize: '3264x2448', images: [{ data: 'template', mimeType: 'image/png' }] }));
    await complete();
    await waitFor(() => expect(result.current.job?.status).toBe('review_grid'));
  });

  it('shows a PNG result honestly and never slices it in native mode', async () => {
    vi.mocked(resolveImagePayloadToBlob).mockResolvedValue(new NodeBlob(['static'], { type: 'image/png' }) as unknown as Blob);
    const { result } = renderHook(useGifWorkflow);
    await act(async () => result.current.submitGrid(input));
    await complete();
    await waitFor(() => expect(result.current.job?.warning).toContain('PNG'));
    expect(result.current.gifBlob).toBeNull();
    expect(result.current.gridImageUrl).toBe('blob:result');
    expect(encodeGifFromGrid).not.toHaveBeenCalled();
  });

  it('restores the original native GIF after reload without re-encoding', async () => {
    saveActiveGifJob({ ...input, id: 'saved', nativeGif: true, status: 'done', gridImageRef: 'IDB:saved-0', createdAt: '', updatedAt: '' });
    const { result } = renderHook(useGifWorkflow);
    await waitFor(() => expect(result.current.gifBlob).toBe(gifBlob));
    expect(result.current.job?.resultFrameCount).toBe(2);
    expect(createNovaTask).not.toHaveBeenCalled();
  });

  it('rejects truncated GIF data instead of treating its header as an animation', async () => {
    const result = await inspectNativeGif(new NodeBlob(['GIF89a'], { type: 'image/gif' }) as unknown as Blob);
    expect(result.warning).toContain('不是有效的多帧 GIF');
    expect(result.frameCount).toBeUndefined();
  });
});
