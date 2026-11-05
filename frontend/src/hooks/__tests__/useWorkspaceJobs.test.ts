import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceJobs } from '@/hooks/useWorkspaceJobs';
import { openDB, saveJobs, type StoredJob } from '@/lib/job-store';

vi.mock('@/lib/job-store', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/job-store')>(), openDB: vi.fn(),
}));
vi.mock('@/lib/settings-storage', () => ({ hasAnyApiKey: () => true }));

beforeEach(() => { localStorage.clear(); vi.mocked(openDB).mockReset(); });

it('hydrates references, markup, and error for a failed job with no output images', async () => {
  const job: StoredJob = {
    id: 'failed-job', mode: 'image-to-image', status: 'failed', model: 'gpt-image-2.6-flare',
    prompt: 'edit', created_at: '2026-11-05T00:00:00Z', output_size: '1K', aspect_ratio: '1:1', temperature: 1,
    refImages: [{ id: 'ref-1', name: 'ref.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,original' }],
    gptImageMarkup: { referenceId: 'ref-1', dataUrl: 'data:image/png;base64,overlay' },
    error: 'upstream failed',
  };
  saveJobs([job]);
  expect(JSON.parse(localStorage.getItem('nova-jobs')!)[0]).not.toHaveProperty('gptImageMarkup');
  const request = { result: [job], onsuccess: undefined as (() => void) | undefined };
  vi.mocked(openDB).mockResolvedValue({
    transaction: () => ({ objectStore: () => ({ getAll: () => request }) }),
  } as unknown as IDBDatabase);
  const { result } = renderHook(() => useWorkspaceJobs());
  await waitFor(() => expect(request.onsuccess).toBeTypeOf('function'));
  act(() => request.onsuccess?.());
  expect(result.current.jobs[0]).toMatchObject({
    images: [], refImages: job.refImages, gptImageMarkup: job.gptImageMarkup, error: 'upstream failed',
  });
});
