// Agent 模式自建上下文系统的 IndexedDB 持久化层
// 默认会话数据库: nova-agent-db (v1)；其他会话: nova-agent-db-${id} (v1)
//   store: messages (keyPath 'id')        —— 对话消息，靠 createdAt 排序
//   store: images   (keyPath 'imgId')     —— 图片登记表（仅描述 + 缩略图 + 字节引用）
//   store: meta      (keyPath 'key')       —— 会话元信息（模型选择等）
// 图片真实字节不在这里，存于 nova-image-db 的 blobs store（复用 image-downloader）。

import {
  storeImageBlob,
  getStoredBlob,
  deleteStoredBlobIfOwner,
  deleteStoredBlobs,
  deleteUnreferencedAgentBlobs,
} from '@/lib/image-downloader';
import { normalizeProductKey } from '@/lib/agent-chat-config';
import { listAgentSessions } from '@/lib/agent-sessions';
import type { AgentMessage, AgentImageRecord, AgentProposal } from '@/lib/agent-chat-config';
import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';

const DB_NAME = 'nova-agent-db';
const DEFAULT_SESSION_ID = 'default';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const IMAGES_STORE = 'images';
const META_STORE = 'meta';

let currentSessionId = DEFAULT_SESSION_ID;
const dbCache = new Map<string, IDBDatabase>();
const dbOpenPromises = new Map<string, Promise<IDBDatabase | null>>();
const sessionGenerations = new Map<string, number>();

function getSessionDbName(id: string): string {
  return id === DEFAULT_SESSION_ID ? DB_NAME : `${DB_NAME}-${id}`;
}

function resolveSessionId(sessionId?: string): string {
  return sessionId ?? currentSessionId;
}

export function getAgentSessionGeneration(sessionId?: string): number {
  return sessionGenerations.get(resolveSessionId(sessionId)) ?? 0;
}

export function invalidateAgentSession(sessionId?: string): number {
  const session = resolveSessionId(sessionId);
  const next = getAgentSessionGeneration(session) + 1;
  sessionGenerations.set(session, next);
  return next;
}

export function isAgentSessionGenerationCurrent(generation: number, sessionId?: string): boolean {
  return getAgentSessionGeneration(sessionId) === generation;
}

/** 非默认会话的 blob 使用独立命名空间；默认会话保留旧 key 以兼容已有数据。 */
function getAgentBlobJobId(imgId: string, sessionId: string): string {
  return sessionId === DEFAULT_SESSION_ID
    ? imgId
    : `agent-session-${encodeURIComponent(sessionId)}-${imgId}`;
}

/** 选择后续 Agent 上下文读写所使用的会话数据库。 */
export function setAgentSession(id: string): void {
  if (id !== currentSessionId) invalidateAgentSession(currentSessionId);
  currentSessionId = id;
}

/** 删除非默认会话数据库及其图片字节；任何失败都向调用方暴露。 */
export async function deleteAgentSessionDatabase(id: string): Promise<void> {
  if (id === DEFAULT_SESSION_ID) {
    throw new Error('默认会话数据库不可删除');
  }
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB 不可用，无法删除会话数据库');
  }

  invalidateAgentSession(id);
  const dbName = getSessionDbName(id);
  let db = dbCache.get(dbName);
  if (!db) {
    const pendingOpen = dbOpenPromises.get(dbName);
    if (pendingOpen) db = await pendingOpen ?? undefined;
  }
  if (!db) db = await openAgentDB(id) ?? undefined;
  if (!db) throw new Error(`无法打开会话数据库: ${id}`);

  const images = await getAllStrict<AgentImageRecord>(db, IMAGES_STORE);
  if (dbCache.get(dbName) === db) dbCache.delete(dbName);
  dbOpenPromises.delete(dbName);
  try { db.close(); } catch { /* ignore */ }

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error(`删除会话数据库失败: ${id}`));
    req.onblocked = () => reject(new Error(`删除会话数据库被阻塞: ${id}`));
  });

  // 只有数据库删除成功后才清理共享 blob，失败时保留会话数据可重试。
  await Promise.all(images.map(image => deleteAgentImageBytes(image.imgId, id)));
}

function openAgentDB(sessionId: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  const dbName = getSessionDbName(sessionId);
  const cachedDb = dbCache.get(dbName);
  if (cachedDb) return Promise.resolve(cachedDb);

  const pendingOpen = dbOpenPromises.get(dbName);
  if (pendingOpen) return pendingOpen;

  const dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onerror = () => {
      dbOpenPromises.delete(dbName);
      resolve(null);
    };
    req.onsuccess = () => {
      const db = req.result;
      const invalidate = () => {
        if (dbCache.get(dbName) === db) dbCache.delete(dbName);
      };
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        invalidate();
      };
      db.onclose = invalidate;
      dbCache.set(dbName, db);
      dbOpenPromises.delete(dbName);
      resolve(db);
    };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: 'imgId' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
  });
  dbOpenPromises.set(dbName, dbPromise);
  return dbPromise;
}

function getAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => resolve([]);
  });
}

function getAllStrict<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve((req.result as T[]) || []);
      req.onerror = () => reject(req.error || new Error(`读取 ${storeName} 失败`));
      tx.onerror = () => reject(tx.error || new Error(`读取 ${storeName} 事务失败`));
    } catch (error) {
      reject(error);
    }
  });
}

// ===== 加载完整会话 =====

/**
 * 旧版 CDP 抓图只把商品标题/来源写进消息，图片记录本身缺少 productKey/productName。
 * 从持久化消息恢复作用域，让旧会话也能按商品分组并按模型上限自动选图。
 */
export function backfillProductScopes(
  messages: AgentMessage[],
  images: AgentImageRecord[],
): { images: AgentImageRecord[]; changedIds: string[] } {
  const scopeByImageId = new Map<string, { productKey: string; productName: string }>();
  const pattern = /已从浏览器抓取商品《([^》]+)》\s*\d+\s*张图并登记：([^（\n]+)（来源：(https?:\/\/[^）\s]+)）/g;

  for (const message of messages) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message.text || '')) !== null) {
      const productName = match[1].trim();
      const productKey = normalizeProductKey(match[3]) || match[3].trim();
      const ids = match[2].split(/[、,，\s]+/).map(id => id.trim()).filter(Boolean);
      for (const imgId of ids) scopeByImageId.set(imgId, { productKey, productName });
    }
  }

  const changedIds: string[] = [];
  const migrated = images.map(image => {
    if (image.productKey) return image;
    const scope = scopeByImageId.get(image.imgId);
    if (!scope) return image;
    changedIds.push(image.imgId);
    return { ...image, ...scope };
  });
  return { images: migrated, changedIds };
}

export interface AgentSessionSnapshot {
  messages: AgentMessage[];
  images: AgentImageRecord[];
  imageModel: string | null;
}

export async function loadAgentSession(sessionId?: string): Promise<AgentSessionSnapshot> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return { messages: [], images: [], imageModel: null };

  const [messages, images, meta] = await Promise.all([
    getAll<AgentMessage>(db, MESSAGES_STORE),
    getAll<AgentImageRecord>(db, IMAGES_STORE),
    getAll<{ key: string; value: string }>(db, META_STORE),
  ]);

  messages.sort((a, b) => a.createdAt - b.createdAt);
  images.sort((a, b) => a.createdAt - b.createdAt);
  const migrated = backfillProductScopes(messages, images);
  if (migrated.changedIds.length > 0) {
    const changed = new Set(migrated.changedIds);
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    const store = tx.objectStore(IMAGES_STORE);
    for (const image of migrated.images) {
      if (changed.has(image.imgId)) store.put(image);
    }
  }
  const imageModel = meta.find(item => item.key === 'imageModel')?.value ?? null;

  return { messages, images: migrated.images, imageModel };
}

// ===== 消息读写 =====

export async function putMessage(
  message: AgentMessage,
  sessionId?: string,
  expectedGeneration?: number,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  const generation = expectedGeneration ?? getAgentSessionGeneration(session);
  if (!isAgentSessionGenerationCurrent(generation, session)) return;
  const db = await openAgentDB(session);
  if (!db || !isAgentSessionGenerationCurrent(generation, session)) return;

  return new Promise((resolve) => {
    const tx = db.transaction(MESSAGES_STORE, 'readwrite');
    tx.objectStore(MESSAGES_STORE).put(message);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ===== 图片登记表读写 =====

export async function putImageRecord(
  record: AgentImageRecord,
  sessionId?: string,
  expectedGeneration?: number,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  const generation = expectedGeneration ?? getAgentSessionGeneration(session);
  if (!isAgentSessionGenerationCurrent(generation, session)) return;
  const db = await openAgentDB(session);
  if (!db || !isAgentSessionGenerationCurrent(generation, session)) return;

  return new Promise((resolve) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    tx.objectStore(IMAGES_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ===== 元信息 =====

export async function saveImageModel(
  model: string,
  sessionId?: string,
  expectedGeneration?: number,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  const generation = expectedGeneration ?? getAgentSessionGeneration(session);
  if (!isAgentSessionGenerationCurrent(generation, session)) return;
  const db = await openAgentDB(session);
  if (!db || !isAgentSessionGenerationCurrent(generation, session)) return;

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key: 'imageModel', value: model });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ===== 撤回消息 =====

export async function deleteMessages(ids: string[], sessionId?: string): Promise<void> {
  if (ids.length === 0) return;
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 从当前 Agent 会话数据库中删除图片登记记录 */
export async function deleteImageRecords(imgIds: string[], sessionId?: string): Promise<void> {
  if (imgIds.length === 0) return;
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    const store = tx.objectStore(IMAGES_STORE);
    for (const id of imgIds) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 删除仍未被消息引用的精确图片记录，并在记录删除成功后清理其 blob。 */
export async function deleteAgentImageIfUnreferenced(
  record: AgentImageRecord,
  sessionId?: string,
  ownerGeneration?: number,
): Promise<boolean> {
  const session = resolveSessionId(sessionId);
  if (ownerGeneration !== undefined && !isAgentSessionGenerationCurrent(ownerGeneration, session)) return false;
  const db = await openAgentDB(session);
  if (!db || (ownerGeneration !== undefined && !isAgentSessionGenerationCurrent(ownerGeneration, session))) return false;

  const deleted = await new Promise<boolean>((resolve) => {
    const tx = db.transaction([MESSAGES_STORE, IMAGES_STORE], 'readwrite');
    const imageStore = tx.objectStore(IMAGES_STORE);
    const imageRequest = imageStore.get(record.imgId);
    const messagesRequest = tx.objectStore(MESSAGES_STORE).getAll();
    let shouldDelete = false;
    let imageLoaded = false;
    let messagesLoaded = false;
    const decide = () => {
      if (!imageLoaded || !messagesLoaded) return;
      const persisted = imageRequest.result as AgentImageRecord | undefined;
      const messages = (messagesRequest.result as AgentMessage[] | undefined) || [];
      shouldDelete = Boolean(
        persisted
        && persisted.createdAt === record.createdAt
        && persisted.sourceTaskId === record.sourceTaskId
        && persisted.remoteUrl === record.remoteUrl
        && persisted.contentHash === record.contentHash
        && !messages.some(message => message.imageIds?.includes(record.imgId)),
      );
      if (shouldDelete) imageStore.delete(record.imgId);
    };
    imageRequest.onsuccess = () => {
      imageLoaded = true;
      decide();
    };
    messagesRequest.onsuccess = () => {
      messagesLoaded = true;
      decide();
    };
    tx.oncomplete = () => resolve(shouldDelete);
    tx.onerror = () => resolve(false);
  });

  if (deleted) {
    if (ownerGeneration === undefined) await deleteAgentImageBytes(record.imgId, session);
    else await deleteStoredBlobIfOwner(getAgentBlobJobId(record.imgId, session), 0, ownerGeneration);
  }
  return deleted;
}

/** 从 nova-image-db 中删除 agent 图片的 blob 字节 */
export async function deleteAgentImageBytes(imgId: string, sessionId?: string): Promise<void> {
  const session = resolveSessionId(sessionId);
  await deleteStoredBlobs(getAgentBlobJobId(imgId, session), 1);
}

/**
 * 清扫 Agent 孤儿 blob：blob 字节还在，但所有存活会话的登记表里都没有对应 imgId。
 * 来源：生成/登记流程中途被中断（如强杀进程）、旧版本残留的登记失败。
 * 启动时跑一次即可；只动 Agent 命名空间的 key，任务结果 blob 不受影响。
 */
export async function sweepAgentOrphanBlobs(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  const validJobIds = new Set<string>();
  const sessionIds = [...new Set([DEFAULT_SESSION_ID, ...listAgentSessions().map(s => s.id)])];
  for (const sessionId of sessionIds) {
    const db = await openAgentDB(sessionId);
    if (!db) continue;
    const images = await getAll<AgentImageRecord>(db, IMAGES_STORE);
    for (const image of images) {
      validJobIds.add(getAgentBlobJobId(image.imgId, sessionId));
    }
  }
  return deleteUnreferencedAgentBlobs(validJobIds);
}

let sweepOncePromise: Promise<number> | null = null;

/** 每次页面加载只清扫一次（useAgentChat 挂载时触发），重复调用返回同一 Promise */
export function sweepAgentOrphanBlobsOnce(): Promise<number> {
  if (!sweepOncePromise) sweepOncePromise = sweepAgentOrphanBlobs();
  return sweepOncePromise;
}

// ===== 清空会话（清空重开） =====

export async function clearAgentSession(
  sessionId?: string,
  invalidatedGeneration?: number,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  const generation = invalidatedGeneration ?? invalidateAgentSession(session);
  const db = await openAgentDB(session);
  if (!db || !isAgentSessionGenerationCurrent(generation, session)) return;

  const images = await new Promise<AgentImageRecord[]>((resolve) => {
    const tx = db.transaction([MESSAGES_STORE, IMAGES_STORE, META_STORE], 'readwrite');
    const imageStore = tx.objectStore(IMAGES_STORE);
    const request = imageStore.getAll();
    let records: AgentImageRecord[] = [];
    request.onsuccess = () => {
      records = (request.result as AgentImageRecord[]) || [];
      tx.objectStore(MESSAGES_STORE).clear();
      imageStore.clear();
      tx.objectStore(META_STORE).clear();
    };
    request.onerror = () => resolve([]);
    tx.oncomplete = () => resolve(records);
    tx.onerror = () => resolve([]);
  });

  await Promise.all(images.map(image => deleteAgentImageBytes(image.imgId, session)));
}

// ===== Pending Proposal 持久化（刷新恢复「等待你确认」状态）=====
// 将待确认的提案、分析文本、推理文本和 reedit 标志存入 meta store，
// 页面刷新后自动恢复 proposal 阶段，避免丢失。

export interface PendingProposalData {
  proposal: AgentProposal;
  pendingAnalysis: string;
  pendingReasoning: string;
  isReedit: boolean;
  /** 当前提案之后排队等待确认的商品提案；刷新后随当前提案一起恢复 */
  queuedProposals?: AgentProposal[];
}

const PENDING_PROPOSAL_KEY = 'pendingProposal';

export async function savePendingProposal(
  data: PendingProposalData,
  sessionId?: string,
  expectedGeneration?: number,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  const generation = expectedGeneration ?? getAgentSessionGeneration(session);
  if (!isAgentSessionGenerationCurrent(generation, session)) return;
  const db = await openAgentDB(session);
  if (!db || !isAgentSessionGenerationCurrent(generation, session)) return;

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key: PENDING_PROPOSAL_KEY, value: JSON.stringify(data) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function loadPendingProposal(sessionId?: string): Promise<PendingProposalData | null> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(PENDING_PROPOSAL_KEY);
    req.onsuccess = () => {
      const entry = req.result as { key: string; value: string } | undefined;
      if (!entry?.value) { resolve(null); return; }
      try {
        resolve(JSON.parse(entry.value) as PendingProposalData);
      } catch {
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

export async function clearPendingProposal(sessionId?: string): Promise<void> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).delete(PENDING_PROPOSAL_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ===== Pending Generation 持久化（刷新恢复所有生图任务）=====

export interface PendingGenerationData {
  taskId: string;
  proposal: AgentProposal;
  pendingAnalysis: string;
  pendingReasoning: string;
  selectedImageIds: string[];
  model: string;
  outputSize: string;
  customSize?: string;
  aspectRatio: string;
  temperature: number;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  parallelCount: number;
  startedAt: number;
  /** 后台任务不占用前台 generating 状态，恢复后独立轮询。 */
  background?: boolean;
}

interface PendingGenerationCollection {
  version: 2;
  tasks: Record<string, PendingGenerationData>;
}

const PENDING_GENERATION_KEY = 'pendingGeneration';

function parsePendingGenerationCollection(value: string): PendingGenerationCollection {
  try {
    const parsed = JSON.parse(value) as PendingGenerationCollection | PendingGenerationData;
    if ('version' in parsed && parsed.version === 2 && parsed.tasks) return parsed;
    if ('taskId' in parsed && typeof parsed.taskId === 'string') {
      return { version: 2, tasks: { [parsed.taskId]: parsed } };
    }
  } catch { /* ignore invalid legacy data */ }
  return { version: 2, tasks: {} };
}

async function updatePendingGenerationTasks(
  sessionId: string | undefined,
  update: (tasks: Record<string, PendingGenerationData>) => void,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const req = store.get(PENDING_GENERATION_KEY);
    req.onsuccess = () => {
      const entry = req.result as { key: string; value: string } | undefined;
      const collection = parsePendingGenerationCollection(entry?.value || '');
      update(collection.tasks);
      if (Object.keys(collection.tasks).length === 0) store.delete(PENDING_GENERATION_KEY);
      else store.put({ key: PENDING_GENERATION_KEY, value: JSON.stringify(collection) });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function savePendingGenerationTask(data: PendingGenerationData, sessionId?: string): Promise<void> {
  return updatePendingGenerationTasks(sessionId, tasks => { tasks[data.taskId] = data; });
}

export function removePendingGenerationTask(taskId: string, sessionId?: string): Promise<void> {
  return updatePendingGenerationTasks(sessionId, tasks => { delete tasks[taskId]; });
}

export async function loadPendingGenerationTasks(sessionId?: string): Promise<PendingGenerationData[]> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return [];

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const req = store.get(PENDING_GENERATION_KEY);
    req.onsuccess = () => {
      const entry = req.result as { key: string; value: string } | undefined;
      const collection = parsePendingGenerationCollection(entry?.value || '');
      if (entry?.value) {
        try {
          const raw = JSON.parse(entry.value) as { version?: number; taskId?: string };
          if (raw.version !== 2 && raw.taskId) {
            store.put({ key: PENDING_GENERATION_KEY, value: JSON.stringify(collection) });
          }
        } catch { /* ignore invalid legacy data */ }
      }
      resolve(Object.values(collection.tasks).sort((a, b) => a.startedAt - b.startedAt));
    };
    req.onerror = () => resolve([]);
  });
}

export async function clearPendingGenerationTasks(sessionId?: string): Promise<void> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).delete(PENDING_GENERATION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** @deprecated Use savePendingGenerationTask. */
export const savePendingGeneration = savePendingGenerationTask;

/** @deprecated Use loadPendingGenerationTasks. */
export async function loadPendingGeneration(sessionId?: string): Promise<PendingGenerationData | null> {
  return (await loadPendingGenerationTasks(sessionId))[0] ?? null;
}

/** @deprecated Use clearPendingGenerationTasks. */
export const clearPendingGeneration = clearPendingGenerationTasks;

// ===== 图片字节存取（复用 nova-image-db 的 blobs store）=====
// 默认会话使用历史 imgId key；其他会话用 sessionId 命名空间隔离。

export async function storeAgentImageBytes(
  imgId: string,
  blob: Blob,
  sessionId?: string,
  expectedGeneration?: number,
): Promise<void> {
  const session = resolveSessionId(sessionId);
  await storeImageBlob(
    getAgentBlobJobId(imgId, session),
    0,
    blob,
    () => expectedGeneration === undefined || isAgentSessionGenerationCurrent(expectedGeneration, session),
    expectedGeneration,
  );
}

/** 查询 nova-upload-cache 中缓存的图片记录 */
interface UploadCacheRecord {
  key: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  originalSize: number;
  processedSize: number;
  width: number;
  height: number;
  createdAt: number;
}

function openUploadCacheDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open('nova-upload-cache', 1);
    req.onerror = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
  });
}

function getFromUploadCache(db: IDBDatabase, key: string): Promise<UploadCacheRecord | null> {
  return new Promise((resolve) => {
    const tx = db.transaction('images', 'readonly');
    const req = tx.objectStore('images').get(key);
    req.onsuccess = () => resolve((req.result as UploadCacheRecord) || null);
    req.onerror = () => resolve(null);
  });
}

/** 从当前会话数据库的 images store 中查询单条图片登记记录 */
export async function getAgentImageRecord(imgId: string, sessionId?: string): Promise<AgentImageRecord | null> {
  const session = resolveSessionId(sessionId);
  const db = await openAgentDB(session);
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(IMAGES_STORE, 'readonly');
    const req = tx.objectStore(IMAGES_STORE).get(imgId);
    req.onsuccess = () => resolve((req.result as AgentImageRecord) || null);
    req.onerror = () => resolve(null);
  });
}

export async function getAgentImageBytes(imgId: string, sessionId?: string): Promise<Blob | null> {
  const session = resolveSessionId(sessionId);
  // 1) 先查 nova-upload-cache（上传图片已压缩缓存于此，与其余模式共享）
  const record = await getAgentImageRecord(imgId, session);
  if (record?.contentHash) {
    try {
      const cacheDb = await openUploadCacheDB();
      if (cacheDb) {
        const cached = await getFromUploadCache(cacheDb, record.contentHash);
        cacheDb.close();
        if (cached?.dataUrl) {
          const base64 = cached.dataUrl.includes(',') ? cached.dataUrl.split(',')[1] : cached.dataUrl;
          if (base64) {
            const mime = cached.mimeType || 'image/png';
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: mime });
          }
        }
      }
    } catch {
      // 读取上传缓存失败时静默降级到 nova-image-db
    }
  }
  // 2) 降级到 nova-image-db（生成图片走此路径）。默认 key 保持旧数据兼容。
  if (session === DEFAULT_SESSION_ID) return getStoredBlob(imgId, 0);
  return getStoredBlob(getAgentBlobJobId(imgId, session), 0);
}

/** 把图片字节转成可直接喂给生图后端的 base64（不含 data: 前缀）
 *
 * 延迟下载支持：如果图片记录包含 remoteUrl 但本地无字节，则按需下载后返回 base64
 */
export async function getAgentImageBase64(
  imgId: string,
  sessionId?: string,
  expectedGeneration?: number,
): Promise<{ data: string; mimeType: string } | null> {
  const session = resolveSessionId(sessionId);
  const generation = expectedGeneration ?? getAgentSessionGeneration(session);
  const blob = await getAgentImageBytes(imgId, session);
  if (!isAgentSessionGenerationCurrent(generation, session)) return null;
  if (blob) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    if (!isAgentSessionGenerationCurrent(generation, session)) return null;
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    return { data: base64, mimeType: blob.type || 'image/png' };
  }

  const sessionData = await loadAgentSession(session);
  if (!isAgentSessionGenerationCurrent(generation, session)) return null;
  const record = sessionData.images.find(r => r.imgId === imgId);
  if (record?.remoteUrl) {
    try {
      const response = await fetch(record.remoteUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!isAgentSessionGenerationCurrent(generation, session)) return null;
      const downloadedBlob = await response.blob();
      if (!isAgentSessionGenerationCurrent(generation, session)) return null;

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(downloadedBlob);
      });
      if (!isAgentSessionGenerationCurrent(generation, session)) return null;
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

      await storeAgentImageBytes(imgId, downloadedBlob, session, generation);
      return { data: base64, mimeType: downloadedBlob.type || record.mimeType || 'image/jpeg' };
    } catch (error) {
      if (!isAgentSessionGenerationCurrent(generation, session)) return null;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`参考图下载失败：${message || '资源不可访问'}，请重新抓取后重试。`);
    }
  }

  return null;
}
