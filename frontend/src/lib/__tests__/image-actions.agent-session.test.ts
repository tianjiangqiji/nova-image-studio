import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveImagePayloadToBlob, type ImageActionPayload } from '../image-actions';

const agentStore = vi.hoisted(() => ({
  getAgentImageBytes: vi.fn(),
}));

vi.mock('@/lib/agent-context-store', () => agentStore);
vi.mock('@/lib/asset-store', () => ({
  addImageAsset: vi.fn(),
  findImageAssetByBlob: vi.fn(),
  getAssetBlob: vi.fn(),
  getAssetFileExtension: vi.fn(() => 'png'),
  touchImageAsset: vi.fn(),
}));
vi.mock('@/lib/job-store', () => ({ getImageSrc: vi.fn((ref: string) => ref) }));
vi.mock('@/lib/image-downloader', () => ({ getStoredBlob: vi.fn() }));
vi.mock('@/lib/upload-image-cache', () => ({
  getOptimizationBadge: vi.fn(),
  prepareUploadImage: vi.fn(),
}));

describe('image actions agent session binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves an agent image through the session carried by its payload', async () => {
    const blob = new Blob(['session-a'], { type: 'text/plain' });
    agentStore.getAgentImageBytes.mockResolvedValue(blob);
    const payload = {
      sourceKind: 'agent' as const,
      agentImageId: 'img_1',
      sessionId: 'session-a',
    } as ImageActionPayload & { sessionId: string };

    await expect(resolveImagePayloadToBlob(payload)).resolves.toBe(blob);
    expect(agentStore.getAgentImageBytes).toHaveBeenCalledWith('img_1', 'session-a');
  });
});
