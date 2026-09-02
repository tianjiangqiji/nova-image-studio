// nova-slice-db IndexedDB 封装
// 维护图片切图的工作区（workspaces）与图片二进制（blobs）两个对象存储。
// 创建逻辑与 backup-utils.ts 中 KNOWN_STORE_DEFS 的 nova-slice-db 定义保持一致，
// 以便备份/恢复流程能正确识别库结构。

import { nanoid } from 'nanoid';

import type { SliceWorkspaceDraft } from './slice-types';

export const SLICE_DB_NAME = 'nova-slice-db';
export const SLICE_DB_VERSION = 1;
export const WORKSPACES_STORE = 'workspaces';
export const BLOBS_STORE = 'blobs';

/** blobs store 中的记录结构 */
interface BlobRecord {
  key: string;
  blob: Blob;
  mimeType: string;
}

// 单例缓存数据库连接，避免每次读写都 open/close。
// 参考 image-db.ts 的模式。
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 打开/创建 nova-slice-db 数据库。
 * - workspaces store: keyPath 'id'
 * - blobs store: keyPath 'key'
 * 与 backup-utils.ts 中 KNOWN_STORE_DEFS 的 nova-slice-db 定义保持一致。
 */
export function openSliceDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB 不可用'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(SLICE_DB_NAME, SLICE_DB_VERSION);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('打开 nova-slice-db 失败'));
    };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(WORKSPACES_STORE)) {
        db.createObjectStore(WORKSPACES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 另一个 tab 触发升级时主动关闭并失效缓存，下次调用会重新打开。
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
  });
  return dbPromise;
}

/**
 * 将 Blob 存入 blobs store。
 * @returns 生成的 key
 */
export async function putBlob(blob: Blob, mimeType: string): Promise<string> {
  try {
    const db = await openSliceDb();
    const key = nanoid();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BLOBS_STORE, 'readwrite');
      const store = tx.objectStore(BLOBS_STORE);
      const record: BlobRecord = { key, blob, mimeType };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return key;
  } catch {
    // 失败时返回空字符串，调用方应据此判断
    return '';
  }
}

/**
 * 读取 Blob。
 * @returns Blob 或 null（不存在或失败时）
 */
export async function getBlob(key: string): Promise<Blob | null> {
  try {
    const db = await openSliceDb();
    const record = await new Promise<BlobRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(BLOBS_STORE, 'readonly');
      const store = tx.objectStore(BLOBS_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as BlobRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    return record?.blob ?? null;
  } catch {
    return null;
  }
}

/**
 * 删除 Blob。不存在或失败时静默忽略。
 */
export async function deleteBlob(key: string): Promise<void> {
  try {
    const db = await openSliceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BLOBS_STORE, 'readwrite');
      const store = tx.objectStore(BLOBS_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

/**
 * 列出所有工作区，按 updatedAt 降序排列。
 */
export async function listWorkspaces(): Promise<SliceWorkspaceDraft[]> {
  try {
    const db = await openSliceDb();
    const all = await new Promise<SliceWorkspaceDraft[]>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly');
      const store = tx.objectStore(WORKSPACES_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as SliceWorkspaceDraft[]) || []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  } catch {
    return [];
  }
}

/**
 * 读取单个工作区。
 */
export async function getWorkspace(id: string): Promise<SliceWorkspaceDraft | null> {
  try {
    const db = await openSliceDb();
    const record = await new Promise<SliceWorkspaceDraft | undefined>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly');
      const store = tx.objectStore(WORKSPACES_STORE);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result as SliceWorkspaceDraft | undefined);
      req.onerror = () => reject(req.error);
    });
    return record ?? null;
  } catch {
    return null;
  }
}

/**
 * 保存工作区（upsert）。
 */
export async function saveWorkspace(draft: SliceWorkspaceDraft): Promise<void> {
  try {
    const db = await openSliceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readwrite');
      const store = tx.objectStore(WORKSPACES_STORE);
      const req = store.put(draft);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

/** 收集工作区关联的所有 Blob key（去重、过滤空值） */
function collectWorkspaceBlobKeys(draft: SliceWorkspaceDraft): string[] {
  const keys = new Set<string>();
  if (draft.sourceImageBlobKey) keys.add(draft.sourceImageBlobKey);
  if (draft.thumbnailBlobKey) keys.add(draft.thumbnailBlobKey);
  for (const asset of draft.assets || []) {
    if (asset.originalBlobKey) keys.add(asset.originalBlobKey);
    if (asset.currentBlobKey) keys.add(asset.currentBlobKey);
    if (asset.transparentBlobKey) keys.add(asset.transparentBlobKey);
    if (asset.aiTransparentBlobKey) keys.add(asset.aiTransparentBlobKey);
  }
  return Array.from(keys);
}

/**
 * 删除工作区及其关联的所有 Blob。
 * 顺序：先读工作区收集 blob key，再删工作区记录，再逐个删 blob。
 */
export async function deleteWorkspace(id: string): Promise<void> {
  try {
    const draft = await getWorkspace(id);
    if (!draft) return;
    const db = await openSliceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readwrite');
      const store = tx.objectStore(WORKSPACES_STORE);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    // 逐个删除关联 blob（失败不影响主流程）
    const blobKeys = collectWorkspaceBlobKeys(draft);
    await Promise.all(blobKeys.map((key) => deleteBlob(key)));
  } catch {
    // ignore
  }
}

/**
 * 深拷贝工作区：复制所有 Blob（生成新 key），构造新工作区（新 id、新时间戳），保存并返回。
 */
export async function copyWorkspace(id: string, newNote?: string): Promise<SliceWorkspaceDraft | null> {
  try {
    const source = await getWorkspace(id);
    if (!source) return null;

    // 深拷贝结构（仅含可序列化数据，Blob 通过 key 引用）
    const next: SliceWorkspaceDraft = structuredClone(source);

    // 复制源图 Blob
    const sourceBlob = await getBlob(source.sourceImageBlobKey);
    if (sourceBlob) {
      next.sourceImageBlobKey = await putBlob(sourceBlob, sourceBlob.type || 'image/png');
    }

    // 复制缩略图 Blob
    if (source.thumbnailBlobKey) {
      const thumbBlob = await getBlob(source.thumbnailBlobKey);
      if (thumbBlob) {
        next.thumbnailBlobKey = await putBlob(thumbBlob, thumbBlob.type || 'image/png');
      } else {
        next.thumbnailBlobKey = null;
      }
    }

    // 复制每个 asset 的 Blob 引用
    for (const asset of next.assets || []) {
      const originalBlob = await getBlob(asset.originalBlobKey);
      if (originalBlob) {
        asset.originalBlobKey = await putBlob(originalBlob, originalBlob.type || 'image/png');
      }
      const currentBlob = await getBlob(asset.currentBlobKey);
      if (currentBlob) {
        asset.currentBlobKey = await putBlob(currentBlob, currentBlob.type || 'image/png');
      }
      if (asset.transparentBlobKey) {
        const transparentBlob = await getBlob(asset.transparentBlobKey);
        asset.transparentBlobKey = transparentBlob
          ? await putBlob(transparentBlob, transparentBlob.type || 'image/png')
          : null;
      }
      if (asset.aiTransparentBlobKey) {
        const aiBlob = await getBlob(asset.aiTransparentBlobKey);
        asset.aiTransparentBlobKey = aiBlob
          ? await putBlob(aiBlob, aiBlob.type || 'image/png')
          : null;
      }
    }

    // 新 id 与时间戳
    const now = new Date().toISOString();
    next.id = nanoid();
    next.note = newNote ?? (source.note ? `${source.note} 副本` : '未命名切图副本');
    next.createdAt = now;
    next.updatedAt = now;

    await saveWorkspace(next);
    return next;
  } catch {
    return null;
  }
}
