// 反推结果的 IndexedDB 持久化层
// 数据库: nova-reverse-db (v1)
// store: reverse-results (keyPath: 'slot')
// 保存文字结果和当前输入图草稿。

export interface StoredReverseResult {
  slot: 'current' | 'previous';
  text: string;
  model: string;
  mode: string;
  aborted?: boolean;
  timestamp: number;
}

export interface StoredReverseDraft {
  slot: 'draft';
  file: {
    id: string;
    name: string;
    preview: string;
    dataUrl: string;
    mimeType: string;
    badge?: string;
  } | null;
  timestamp: number;
}

const DB_NAME = 'nova-reverse-db';
const DB_VERSION = 1;
const STORE_NAME = 'reverse-results';

// 单例缓存数据库连接（参考 image-db.ts 的模式），避免每次读写 open 后泄漏连接。
let reverseDbPromise: Promise<IDBDatabase | null> | null = null;

function openReverseDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (reverseDbPromise) return reverseDbPromise;

  reverseDbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { reverseDbPromise = null; resolve(null); };
    req.onsuccess = () => {
      const db = req.result;
      // 另一个 tab 或备份导入触发版本变更时主动关闭并失效缓存，下次调用会重新打开。
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        reverseDbPromise = null;
      };
      db.onclose = () => { reverseDbPromise = null; };
      resolve(db);
    };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'slot' });
      }
    };
  });
  return reverseDbPromise;
}

/** 从 IndexedDB 加载 current / previous 两条记录 */
export async function loadReverseResults(): Promise<{
  current: StoredReverseResult | null;
  previous: StoredReverseResult | null;
  draft: StoredReverseDraft | null;
}> {
  const db = await openReverseDB();
  if (!db) return { current: null, previous: null, draft: null };

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    let current: StoredReverseResult | null = null;
    let previous: StoredReverseResult | null = null;
    let draft: StoredReverseDraft | null = null;

    const getReq = store.get('current');
    getReq.onsuccess = () => {
      current = (getReq.result as StoredReverseResult) ?? null;
    };

    const getReq2 = store.get('previous');
    getReq2.onsuccess = () => {
      previous = (getReq2.result as StoredReverseResult) ?? null;
    };

    const getReq3 = store.get('draft');
    getReq3.onsuccess = () => {
      draft = (getReq3.result as StoredReverseDraft) ?? null;
    };

    tx.oncomplete = () => resolve({ current, previous, draft });
    tx.onerror = () => resolve({ current: null, previous: null, draft: null });
  });
}

/** 保存单条记录到指定槽位 */
export async function saveReverseResult(result: StoredReverseResult): Promise<void> {
  const db = await openReverseDB();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(result);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 清除指定槽位 */
export async function clearReverseResult(slot: 'current' | 'previous'): Promise<void> {
  const db = await openReverseDB();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(slot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 保存当前输入图草稿 */
export async function saveReverseDraft(file: StoredReverseDraft['file']): Promise<void> {
  const db = await openReverseDB();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ slot: 'draft', file, timestamp: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 清除当前输入图草稿 */
export async function clearReverseDraft(): Promise<void> {
  const db = await openReverseDB();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('draft');
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
