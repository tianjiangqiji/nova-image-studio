import { beforeEach, describe, expect, it } from 'vitest';
import { loadJobs, saveJobs, MAX_STORED_JOBS, type StoredJob } from '@/lib/job-store';

function makeJob(id: string, status: StoredJob['status'], createdAt: string): StoredJob {
  return {
    id,
    status,
    mode: 'text-to-image',
    prompt: '测试',
    output_size: '1K',
    temperature: 1,
    aspect_ratio: '1:1',
    model: 'test-model',
    created_at: createdAt,
  };
}

describe('saveJobs 历史上限', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('超过上限时淘汰最旧的已完成记录，进行中的任务永远保留', () => {
    const active = makeJob('active-job', 'processing', '2020-01-01T00:00:00.000Z');
    const settled = Array.from({ length: MAX_STORED_JOBS + 10 }, (_, index) =>
      makeJob(`job-${index}`, 'completed', new Date(2024, 0, 1, 0, 0, index).toISOString()));

    saveJobs([active, ...settled]);

    const stored = loadJobs();
    expect(stored).toHaveLength(MAX_STORED_JOBS);
    expect(stored.some(job => job.id === 'active-job')).toBe(true);
    // 最旧的被淘汰，最新的保留
    expect(stored.some(job => job.id === 'job-0')).toBe(false);
    expect(stored.some(job => job.id === `job-${MAX_STORED_JOBS + 9}`)).toBe(true);
  });

  it('未超上限时原样保留', () => {
    const jobs = [
      makeJob('a', 'completed', '2024-01-01T00:00:00.000Z'),
      makeJob('b', 'failed', '2024-01-02T00:00:00.000Z'),
    ];
    saveJobs(jobs);
    expect(loadJobs().map(job => job.id).sort()).toEqual(['a', 'b']);
  });
});
