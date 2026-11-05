import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasAnyApiKey } from '@/lib/settings-storage';
import {
  deleteImage,
  loadJobs,
  openDB,
  saveImage,
  saveJobs,
  IMG_STORE,
  type Mode,
  type StoredJob,
} from '@/lib/job-store';
import type { ModelId } from '@/lib/gemini-config';
import { getCompatibleRetryData, type RetryData } from '@/lib/model-capabilities';
import { classifyFailureFromMessage } from '@/lib/task-failure';
import { deleteStoredBlobs, revokeBlobUrls } from '@/lib/image-downloader';
import { retryDownloadCachedImages } from '@/lib/workspace-task-service';

function isWaitingJob(job: StoredJob): boolean {
  return job.status === 'processing' || job.status === 'queued' || job.status === '排队中';
}

function loadInitialJobs(): StoredJob[] {
  return loadJobs().map(job => ({
    ...job,
    ...(isWaitingJob(job) && !job.serverTaskId ? { status: 'failed' as const, error: '页面刷新，任务已中断', terminal: true } : {}),
    ...(!job.model ? { model: 'gemini-3-pro-image-preview' as ModelId } : {}),
  }));
}

export function useWorkspaceJobs() {
  const [hasApiKey, setHasApiKey] = useState(() => hasAnyApiKey());
  const [jobs, setJobs] = useState<StoredJob[]>(loadInitialJobs);
  const jobsRef = useRef(jobs);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [retryData, setRetryData] = useState<RetryData | null>(null);
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState<Mode | null>(null);
  const [cancelJobId, setCancelJobId] = useState<string | null>(null);

  useEffect(() => {
    const stored = loadInitialJobs();
    saveJobs(stored);

    if (stored.length > 0) {
      openDB()
        .then(db => {
          if (!db) return;
          const request = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE).getAll();
          request.onsuccess = () => {
            const imageMap = new Map<string, StoredJob>();
            for (const image of request.result as StoredJob[]) {
              imageMap.set(image.id, image);
            }

            setJobs(prev => prev.map(job => {
              const image = imageMap.get(job.id);
              if (!image) return job;

              const persistedImages = image.images || (image.imageData ? [image.imageData] : []);
              return {
                ...job,
                images: persistedImages,
                imageData: persistedImages[0],
                refImages: image.refImages,
                gptImageMarkup: image.gptImageMarkup,
                error: image.error,
              };
            }));
            setLoadedImages(new Set(imageMap.keys()));
          };
        })
        .catch(() => undefined);
    }
  }, []);

  const persistJobs = useCallback((updater: (prev: StoredJob[]) => StoredJob[]) => {
    setJobs(prev => {
      const next = updater(prev);
      saveJobs(next);
      return next;
    });
  }, []);

  const addJob = useCallback((job: StoredJob) => {
    persistJobs(prev => [job, ...prev]);
  }, [persistJobs]);

  const replaceJob = useCallback((jobId: string, updater: (job: StoredJob) => StoredJob) => {
    persistJobs(prev => prev.map(job => (job.id === jobId ? updater(job) : job)));
  }, [persistJobs]);

  const hasJob = useCallback((jobId: string) => {
    return jobsRef.current.some(job => job.id === jobId);
  }, []);

  // 返回最新的 job 快照（来自 jobsRef），供异步回调避免捕获过期闭包。
  const getJob = useCallback((jobId: string) => {
    return jobsRef.current.find(job => job.id === jobId);
  }, []);

  const completeJob = useCallback(async (jobId: string, job: StoredJob) => {
    persistJobs(prev => prev.map(current => (current.id === jobId ? job : current)));
    setLoadedImages(prev => {
      const next = new Set(prev);
      next.add(job.id);
      return next;
    });
    await saveImage(job).catch(() => undefined);
  }, [persistJobs]);

  const failJob = useCallback(async (jobId: string, error: string, options?: { terminal?: boolean }) => {
    let failedJob: StoredJob | null = null;
    persistJobs(prev => prev.map(job => {
      if (job.id !== jobId) return job;
      const classification = classifyFailureFromMessage(error);
      const terminal = options?.terminal ?? classification.terminal;
      failedJob = {
        ...job,
        status: 'failed',
        error,
        networkError: classification.reason === 'network',
        terminal,
      };
      return failedJob;
    }));

    if (failedJob) {
      await saveImage(failedJob).catch(() => undefined);
    }
  }, [persistJobs]);

  const removeJob = useCallback(async (jobId: string) => {
    const removedJob = jobsRef.current.find(job => job.id === jobId);
    if (removedJob?.blobUrls) {
      revokeBlobUrls(removedJob.blobUrls);
    }
    persistJobs(prev => prev.filter(job => job.id !== jobId));
    setLoadedImages(prev => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
    await Promise.all([
      deleteImage(jobId).catch(() => undefined),
      deleteStoredBlobs(jobId, removedJob?.images?.length).catch(() => undefined),
    ]);
  }, [persistJobs]);

  const clearJobsByMode = useCallback(async (modeFilter: Mode) => {
    const toRemove = jobsRef.current.filter(job => job.mode === modeFilter);
    if (toRemove.length === 0) {
      setClearAllDialogOpen(null);
      return;
    }

    for (const job of toRemove) {
      if (job.blobUrls) {
        revokeBlobUrls(job.blobUrls);
      }
    }
    persistJobs(prev => prev.filter(job => job.mode !== modeFilter));
    setLoadedImages(prev => {
      const next = new Set(prev);
      for (const job of toRemove) {
        next.delete(job.id);
      }
      return next;
    });

    await Promise.all(toRemove.flatMap(job => [
      deleteImage(job.id).catch(() => undefined),
      deleteStoredBlobs(job.id, job.images?.length).catch(() => undefined),
    ]));
    setClearAllDialogOpen(null);
  }, [persistJobs]);

  const textJobs = useMemo(
    () => jobs.filter(job => job.mode === 'text-to-image').sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [jobs]
  );
  const imageJobs = useMemo(
    () => jobs.filter(job => job.mode === 'image-to-image').sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [jobs]
  );

  const retryJob = useCallback((job: StoredJob) => {
    setRetryData(getCompatibleRetryData(job));
  }, []);

  /**
   * "重新下载"按钮回调：尝试把 URL: 引用的图片缓存到本地 IndexedDB。
   * 成功 → 清空 warning 并 ack 服务端任务；失败 → 保持现状，UI 仍显示 warning。
   * 不抛错；调用方（按钮）通过本地 retrying 状态显示 spinner，无需感知错误细节。
   */
  const retryDownload = useCallback(async (job: StoredJob) => {
    try {
      await retryDownloadCachedImages(job, {
        addJob,
        replaceJob,
        completeJob,
        failJob,
      });
    } catch {
      // retryDownload failure is non-critical
    }
  }, [addJob, replaceJob, completeJob, failJob]);

  return {
    hasApiKey,
    jobs,
    textJobs,
    imageJobs,
    loadedImages,
    retryData,
    clearAllDialogOpen,
    cancelJobId,
    setHasApiKey,
    setRetryData,
    setClearAllDialogOpen,
    setCancelJobId,
    retryJob,
    retryDownload,
    hasJob,
    getJob,
    addJob,
    replaceJob,
    completeJob,
    failJob,
    removeJob,
    clearJobsByMode,
  };
}
