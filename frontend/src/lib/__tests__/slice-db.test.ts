import { describe, expect, it } from 'vitest';

import { collectWorkspaceBlobKeys, copyWorkspaceBlobReferences } from '@/lib/slice-db';
import type { SliceWorkspaceDraft } from '@/lib/slice-types';

const workspace: SliceWorkspaceDraft = {
  id: 'workspace',
  note: 'test',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  screen: { width: 100, height: 100 },
  sourceImageBlobKey: 'source',
  thumbnailBlobKey: 'thumbnail',
  assets: [
    {
      id: 'asset',
      name: 'asset',
      type: 'icon',
      placement: { x: 0, y: 0, width: 10, height: 10 },
      radius: 0,
      transparent: false,
      aiTransparent: false,
      aiCompleted: false,
      hidden: false,
      originalBlobKey: 'original',
      currentBlobKey: 'current',
      repairBlobKey: 'repair',
      processSnapshots: {
        transparent: { currentBlobKey: 'snapshot-transparent', transparent: false, aiTransparent: false },
        aiSvg: { currentBlobKey: 'snapshot-ai-svg', transparent: false, aiTransparent: false },
      },
    },
  ],
};

describe('slice workspace blob references', () => {
  it('collects repair and process snapshot blob keys', () => {
    expect(collectWorkspaceBlobKeys(workspace)).toEqual(expect.arrayContaining([
      'source',
      'thumbnail',
      'original',
      'current',
      'repair',
      'snapshot-transparent',
      'snapshot-ai-svg',
    ]));
  });

  it('copies every referenced blob once and rewrites snapshot and repair references', async () => {
    const blobs = new Map(collectWorkspaceBlobKeys(workspace).map((key) => [key, new Blob([key], { type: 'image/png' })]));
    const writes: Blob[] = [];
    const copied = await copyWorkspaceBlobReferences(workspace, async (key) => blobs.get(key) ?? null, async (blob) => {
      writes.push(blob);
      return `copy-${writes.length}`;
    });

    expect(writes).toHaveLength(7);
    expect(copied.assets[0].repairBlobKey).toBe('copy-5');
    expect(copied.assets[0].processSnapshots?.transparent?.currentBlobKey).toBe('copy-6');
    expect(copied.assets[0].processSnapshots?.aiSvg?.currentBlobKey).toBe('copy-7');
  });

  it('preserves absent optional blob fields when copying a workspace', async () => {
    const sparse = structuredClone(workspace);
    delete sparse.thumbnailBlobKey;
    delete sparse.assets[0].transparentBlobKey;
    delete sparse.assets[0].aiTransparentBlobKey;
    delete sparse.assets[0].repairBlobKey;
    delete sparse.assets[0].processSnapshots;
    const blobs = new Map(collectWorkspaceBlobKeys(sparse).map((key) => [key, new Blob([key], { type: 'image/png' })]));

    let writes = 0;
    const copied = await copyWorkspaceBlobReferences(sparse, async (key) => blobs.get(key) ?? null, async () => `copy-${++writes}`);

    expect('thumbnailBlobKey' in copied).toBe(false);
    expect('transparentBlobKey' in copied.assets[0]).toBe(false);
    expect('repairBlobKey' in copied.assets[0]).toBe(false);
  });
});
