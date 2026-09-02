'use client';

import { zip, unzip, zipSync, unzipSync, strToU8, type Unzipped } from 'fflate';
import localforage from 'localforage';

export interface BackupProgress {
    percent: number;
    message: string;
}

export type ProgressCallback = (progress: BackupProgress) => void;

type BackupRecord = Record<string, unknown>;
type DatabaseBackup = Record<string, BackupRecord[]>;
type IndexedDBBackup = Record<string, DatabaseBackup>;
type BlobRef = { _blobRef: string; _blobMimeType: string };

function isBackupRecord(value: unknown): value is BackupRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlobRef(value: unknown): value is BlobRef {
    return isBackupRecord(value)
        && typeof value['_blobRef'] === 'string'
        && typeof value['_blobMimeType'] === 'string';
}

// localStorage keys to backup
const LOCAL_STORAGE_KEYS = [
    'nova-model-registry',
    'nova-jobs',
    'nova-t2i-settings',
    'nova-i2i-settings',
    'nova-reverse-prompt-settings',
    'theme',
    'nova-wide-mode',
    // Agent 模式
    'nova-agent-params',
    'nova-agent-web-search',
    'nova-agent-intent-recognition',
    // 生图工作台主设置（模型/尺寸/质量/风格/并行数等）
    'nova-image-generation-settings',
    // 动图生成
    'nova-gif-settings',
    'nova-gif-active-job',
    'nova-gif-tuner-mobile-hint-hidden',
    // 我的素材
    'nova-assets-settings',
    // 无限画布生成配置
    'nova-image:canvas_config',
    // UI设计模式（图片切图）的图片模型选择
    'nova-slice-settings',
];

/**
 * 已知 IndexedDB 库及对象存储定义。
 * - 导出：按库名白名单过滤（避免误导三方库），但 store 按 objectStoreNames 动态枚举，
 *   未来新增 store 无需改本文件也能被备份。
 * - 导入：仅用于「目标库不存在需初始化」且备份未携带 schema.json（旧备份）时的兜底。
 * 各字段的 keyPath/索引须与对应 store 模块保持一致。
 */
const KNOWN_STORE_DEFS: Record<string, Record<string, { keyPath: string; indexes?: Record<string, string> }>> = {
    'nova-image-db': {
        images: { keyPath: 'id' },
        blobs: { keyPath: 'key' },
    },
    'nova-reverse-db': {
        'reverse-results': { keyPath: 'slot' },
    },
    'nova-upload-cache': {
        images: { keyPath: 'key' },
    },
    'nova-agent-db': {
        messages: { keyPath: 'id' },
        images: { keyPath: 'imgId' },
        meta: { keyPath: 'key' },
    },
    'nova-assets-db': {
        assets: { keyPath: 'id', indexes: { hash: 'hash', createdAt: 'createdAt' } },
        'asset-blobs': { keyPath: 'key' },
    },
    'nova-slice-db': {
        workspaces: { keyPath: 'id' },
        blobs: { keyPath: 'key' },
    },
};

/** 备份内 indexedDB/schema.json 的结构：记录每个 store 的 keyPath 与索引，导入时可据此重建 */
type StoreSchema = { keyPath: string | string[] | null; autoIncrement: boolean; indexes: Record<string, string | string[]> };
type DbSchema = Record<string, { stores: Record<string, StoreSchema> }>;

// localforage keyless 实例（无限画布：项目状态 + 图片 blob）。
// 通用 IndexedDB 逻辑面向 keyPath store，无法 round-trip localforage 的无 keyPath store，故单独处理。
const LOCALFORAGE_STORES: { name: string; storeName: string }[] = [
    { name: 'nova-image', storeName: 'canvas_app_state' },
    { name: 'nova-image', storeName: 'canvas_image_files' },
];

type LocalForageEntry = { key: string; value: unknown } | { key: string; _blobRef: string; _blobMimeType: string };
type LocalForageBackup = Record<string, Record<string, LocalForageEntry[]>>;

/** Blob → Uint8Array（fflate 需要 Uint8Array） */
async function blobToUint8(blob: Blob): Promise<Uint8Array> {
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
}

// 用于生成导出时 Blob 的唯一引用 ID
let _blobRefSeq = 0;
function nextBlobRef(): string {
    return `b${Date.now()}_${++_blobRefSeq}`;
}

/**
 * 将 JSON 数据转为 fflate 可用的 Uint8Array
 */
function jsonToU8(data: unknown): Uint8Array {
    return strToU8(JSON.stringify(data));
}

/** fflate 异步压缩（Web Worker 中执行，大备份不冻结主线程）；Worker 不可用时降级为同步 */
function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        try {
            zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
        } catch {
            try {
                resolve(zipSync(files, { level: 6 }));
            } catch (syncErr) {
                reject(syncErr);
            }
        }
    });
}

/** fflate 异步解压（Web Worker 中执行，不冻结主线程）；Worker 不可用时降级为同步 */
function unzipAsync(data: Uint8Array): Promise<Unzipped> {
    return new Promise((resolve, reject) => {
        try {
            unzip(data, (err, unzipped) => (err ? reject(err) : resolve(unzipped)));
        } catch {
            try {
                resolve(unzipSync(data));
            } catch (syncErr) {
                reject(syncErr);
            }
        }
    });
}

/**
 * 导出 localforage（keyless）store：保留 key；Blob 值以二进制存入 ZIP blobs/，JSON 内留引用。
 * Blob → Uint8Array 的转换必须全部完成后才返回，否则打包时数据可能尚未写入 files（曾导致画布图片丢失）。
 */
async function exportLocalForage(files: Record<string, Uint8Array>): Promise<LocalForageBackup> {
    const result: LocalForageBackup = {};
    for (const cfg of LOCALFORAGE_STORES) {
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            const entries: LocalForageEntry[] = [];
            const pendingConversions: Promise<void>[] = [];
            await instance.iterate((value: unknown, key: string) => {
                if (value instanceof Blob) {
                    const ref = nextBlobRef();
                    pendingConversions.push(
                        blobToUint8(value).then(u8 => { files[`blobs/${ref}`] = u8; })
                    );
                    entries.push({ key, _blobRef: ref, _blobMimeType: value.type });
                } else {
                    entries.push({ key, value });
                }
            });
            // 等待所有 Blob 转换写入 files 后再进入打包阶段
            await Promise.all(pendingConversions);
            if (!result[cfg.name]) result[cfg.name] = {};
            result[cfg.name][cfg.storeName] = entries;
        } catch {
            // skip failed localforage export
        }
    }
    return result;
}

/**
 * 导入 localforage（keyless）store：先清空，再按 key 写回；Blob 从 ZIP 还原。
 * @returns 因备份缺少图片数据而被跳过的条目数
 */
async function importLocalForage(data: LocalForageBackup, unzipped: Record<string, Uint8Array>): Promise<number> {
    let skipped = 0;
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        if (!Array.isArray(entries)) continue;
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            await instance.clear();
            for (const entry of entries) {
                let value: unknown;
                if ('_blobRef' in entry && typeof entry._blobRef === 'string') {
                    const blobData = unzipped[`blobs/${entry._blobRef}`];
                    if (!blobData) {
                        skipped++;
                        continue;
                    }
                    value = new Blob([blobData as unknown as BlobPart], { type: entry._blobMimeType });
                } else {
                    value = (entry as { value: unknown }).value;
                }
                await instance.setItem(entry.key, value);
            }
        } catch {
            // skip failed localforage import
        }
    }
    return skipped;
}

/**
 * 导出 localStorage 数据
 */
function exportLocalStorage(): Record<string, string> {
    const data: Record<string, string> = {};

    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            const value = localStorage.getItem(key);
            if (value !== null) {
                data[key] = value;
            }
        } catch {
            // skip failed localStorage export
        }
    }

    return data;
}

/**
 * 打开（或按需创建）数据库。
 * 不带版本号打开：无论现有库版本多高都能直接附加，避免 VersionError 导致整个库被静默跳过；
 * 也不会触发版本变更，因此导入时不会被本页/其他标签页的既有连接阻塞。
 */
function openDatabase(name: string, schema?: DbSchema): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }

        const request = indexedDB.open(name);

        request.onerror = () => resolve(null);
        request.onsuccess = () => {
            const db = request.result;
            // 其他标签页或备份流程触发版本变更时主动释放，避免阻塞对方
            db.onversionchange = () => {
                try { db.close(); } catch { /* ignore */ }
            };
            resolve(db);
        };
        request.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            // 只在全新建库时创建 stores；已存在的库保持原样
            if ((e.oldVersion || 0) > 0) return;
            createKnownStores(db, name, schema);
        };
    });
}

/**
 * 在版本升级事务中创建已知的对象存储。
 * 备份携带的 schema.json 优先（可覆盖未来版本新增的 store），代码内已知定义兜底（兼容旧备份）。
 */
function createKnownStores(db: IDBDatabase, dbName: string, schema?: DbSchema): void {
    const fromSchema = schema?.[dbName]?.stores;
    const fromCode = KNOWN_STORE_DEFS[dbName];
    const source = fromSchema ?? fromCode;
    if (!source) return;

    for (const [storeName, def] of Object.entries(source)) {
        if (db.objectStoreNames.contains(storeName)) continue;
        const keyPath = def.keyPath ?? undefined;
        const store = keyPath
            ? db.createObjectStore(storeName, { keyPath, autoIncrement: !!def.autoIncrement })
            : db.createObjectStore(storeName);
        const indexes = (def.indexes ?? {}) as Record<string, string | string[]>;
        for (const [indexName, indexKeyPath] of Object.entries(indexes)) {
            store.createIndex(indexName, indexKeyPath);
        }
    }
}

/** 读取 store 的 keyPath / 自增 / 索引定义，写入备份 schema */
function readStoreSchema(db: IDBDatabase, storeName: string): StoreSchema {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const indexes: Record<string, string | string[]> = {};
    for (const indexName of Array.from(store.indexNames)) {
        const idx = store.index(indexName);
        indexes[indexName] = idx.keyPath as string | string[];
    }
    return {
        keyPath: (store.keyPath as string | string[] | null) ?? null,
        autoIncrement: store.autoIncrement,
        indexes,
    };
}

/**
 * 导出单个 IndexedDB store 的所有数据
 * Blob 字段转为 Uint8Array 存入 files，JSON 中只保留引用
 */
async function exportStore(db: IDBDatabase, storeName: string, files: Record<string, Uint8Array>): Promise<BackupRecord[]> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = async () => {
                const records = request.result;

                const processedRecords = await Promise.all(
                    records.map(async (record) => {
                        const processed = { ...record };

                        // 遍历所有字段，将 Blob 类型以二进制存入 files
                        for (const key of Object.keys(processed)) {
                            const val = processed[key];
                            if (val instanceof Blob) {
                                const ref = nextBlobRef();
                                files[`blobs/${ref}`] = await blobToUint8(val);
                                processed[key] = { _blobRef: ref, _blobMimeType: val.type };
                            }
                        }

                        return processed;
                    })
                );

                resolve(processedRecords);
            };

            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导出所有 IndexedDB 数据与库结构（schema）。
 * store 按 objectStoreNames 动态枚举，未来新增的 store 无需改本文件也会被备份。
 */
async function exportIndexedDB(
    files: Record<string, Uint8Array>,
    onProgress?: ProgressCallback,
): Promise<{ data: IndexedDBBackup; schema: DbSchema }> {
    const allData: IndexedDBBackup = {};
    const schema: DbSchema = {};

    // 打开全部已知库并收集实际存在的 store
    const opened: { name: string; db: IDBDatabase; stores: string[] }[] = [];
    for (const dbName of Object.keys(KNOWN_STORE_DEFS)) {
        const db = await openDatabase(dbName);
        if (!db) continue;
        const stores = Array.from(db.objectStoreNames);
        opened.push({ name: dbName, db, stores });
    }

    const totalStores = opened.reduce((sum, e) => sum + e.stores.length, 0);
    let completedStores = 0;

    try {
        for (const { name: dbName, db, stores } of opened) {
            const dbData: DatabaseBackup = {};
            const schemaStores: Record<string, StoreSchema> = {};

            for (const storeName of stores) {
                try {
                    dbData[storeName] = await exportStore(db, storeName, files);
                    schemaStores[storeName] = readStoreSchema(db, storeName);

                    completedStores++;
                    if (onProgress) {
                        const percent = 10 + Math.floor((completedStores / Math.max(totalStores, 1)) * 80);
                        onProgress({
                            percent,
                            message: `正在导出 ${dbName}/${storeName}...`,
                        });
                    }
                } catch {
                    // store export failed, continue with next
                }
            }

            db.close();
            allData[dbName] = dbData;
            schema[dbName] = { stores: schemaStores };
        }
    } finally {
        for (const { db } of opened) {
            try { db.close(); } catch { /* ignore */ }
        }
    }

    return { data: allData, schema };
}

/**
 * 导出所有数据为 ZIP 文件
 * 使用 fflate 在 Web Worker 中异步压缩，避免大备份冻结页面
 */
export async function exportAllData(onProgress?: ProgressCallback): Promise<Blob> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导出数据...' });
    }

    // 导出 localStorage
    if (onProgress) {
        onProgress({ percent: 5, message: '正在导出 localStorage...' });
    }
    const localStorageData = exportLocalStorage();

    // 逐 store 导出 IndexedDB，Blob 数据直接转为 Uint8Array 存入 files
    const files: Record<string, Uint8Array> = {};
    const { data: indexedDBData, schema } = await exportIndexedDB(files, onProgress);

    // 导出 localforage 数据
    const localForageData = await exportLocalForage(files);

    // 打包元数据和 localStorage JSON
    if (onProgress) {
        onProgress({ percent: 90, message: '正在打包数据...' });
    }

    // 添加元数据
    files['metadata.json'] = jsonToU8({
        version: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
        exportDate: new Date().toISOString(),
        appName: 'Nova Studio',
    });

    // 添加 localStorage 数据
    files['localStorage.json'] = jsonToU8(localStorageData);

    // 添加 IndexedDB 数据与库结构
    files['indexedDB/schema.json'] = jsonToU8(schema);
    for (const [dbName, dbData] of Object.entries(indexedDBData)) {
        files[`indexedDB/${dbName}.json`] = jsonToU8(dbData);
    }

    // 添加 localforage（无限画布）数据
    for (const [dbName, dbData] of Object.entries(localForageData)) {
        files[`localforage/${dbName}.json`] = jsonToU8(dbData);
    }

    if (onProgress) {
        onProgress({ percent: 95, message: '正在生成 ZIP 文件...' });
    }

    const zipped = await zipAsync(files);
    const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });

    if (onProgress) {
        onProgress({ percent: 100, message: '导出完成！' });
    }

    return blob;
}

/**
 * 从 base64 字符串创建 Blob
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);

    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

/**
 * 导入 localStorage 数据（带校验）
 */
function importLocalStorage(data: unknown): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;

    const allowedKeySet = new Set(LOCAL_STORAGE_KEYS);
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        // 只允许白名单内的键名
        if (!allowedKeySet.has(key)) continue;
        // 只允许字符串值
        if (typeof value !== 'string') continue;

        // 模型注册表含各模型的 API Key 与端点，结构损坏时整条跳过，避免覆盖成坏数据
        if (key === 'nova-model-registry') {
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    continue;
                }
                const record = parsed as Record<string, unknown>;
                const hasImageModels = Array.isArray(record.imageModels);
                const hasTextModels = Array.isArray(record.textModels);
                const hasDefaults = typeof record.defaults === 'object' && record.defaults !== null;
                if (!hasImageModels || !hasTextModels || !hasDefaults) {
                    continue;
                }
            } catch {
                continue;
            }
        }

        try {
            localStorage.setItem(key, value);
        } catch {
            // skip failed localStorage import
        }
    }
}

/**
 * 导入单个 store 的数据。
 * 备份中缺少 Blob 二进制的记录整条跳过（避免把 {_blobRef} 占位对象写回库导致数据损坏），
 * clear + put 在同一事务中完成，保证「覆盖导入」的原子性。
 * @returns 因缺少图片数据而被跳过的记录数
 */
async function importStore(db: IDBDatabase, storeName: string, records: BackupRecord[], unzipped: Record<string, Uint8Array>): Promise<number> {
    let skipped = 0;

    // 先预处理记录：从解压数据提取二进制 / base64 解码
    const processedRecords: BackupRecord[] = [];
    for (const record of records) {
        if (!isBackupRecord(record)) continue;
        const processed: BackupRecord = { ...record };
        let missingBlob = false;

        for (const key of Object.keys(processed)) {
            const val = processed[key];

            // 新格式：_blobRef 对象 → 从解压数据恢复 Blob
            if (isBlobRef(val)) {
                const blobData = unzipped[`blobs/${val._blobRef}`];
                if (blobData) {
                    processed[key] = new Blob([blobData as unknown as BlobPart], { type: val._blobMimeType });
                } else {
                    missingBlob = true;
                }
                continue;
            }

            // 旧格式兼容：base64 字符串 + 记录级 _blobMimeType（旧版备份的 Blob 均存于 'blob' 字段）
            if (key === 'blob' && typeof val === 'string' && typeof record._blobMimeType === 'string') {
                try {
                    processed.blob = base64ToBlob(val, record._blobMimeType);
                } catch {
                    // base64 解析失败时保留原值，按普通数据写入
                }
            }
        }

        if (missingBlob) {
            skipped++;
            continue;
        }

        // 清理旧格式遗留的 _blobMimeType（新格式按字段内嵌携带）
        if ('_blobMimeType' in processed && typeof processed._blobMimeType === 'string') {
            delete processed._blobMimeType;
        }

        processedRecords.push(processed);
    }

    // 再写回 IndexedDB
    await new Promise<void>((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);

            store.clear();
            for (const processedRecord of processedRecords) {
                store.put(processedRecord);
            }

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });

    return skipped;
}

/**
 * 导入 IndexedDB 数据。
 * 直接附加现有库后 clear + put（不再 deleteDatabase 重建）：
 * 不触发版本变更，因此不会因本页或其它标签页的既有连接被 blocked，
 * 也就不会出现 delete 排队导致后续 open 永久挂起、导入卡死的问题。
 * @returns 警告信息列表
 */
async function importIndexedDB(
    data: IndexedDBBackup,
    schema: DbSchema | undefined,
    unzipped: Record<string, Uint8Array>,
    onProgress?: ProgressCallback,
): Promise<string[]> {
    const warnings: string[] = [];
    let completedStores = 0;
    const totalStores = Object.values(data).reduce(
        (sum, dbData) => sum + (dbData && typeof dbData === 'object' ? Object.keys(dbData).length : 0),
        0,
    );

    // 按 ZIP 中实际存在的库导入（不局限于已知清单，支持未来新增的库）
    for (const dbName of Object.keys(data)) {
        const dbData = data[dbName];
        if (!dbData || typeof dbData !== 'object') continue;

        const db = await openDatabase(dbName, schema);
        if (!db) {
            warnings.push(`无法打开数据库 ${dbName}，其数据未被导入`);
            continue;
        }

        for (const storeName of Object.keys(dbData)) {
            const storeData = dbData[storeName];
            if (!Array.isArray(storeData)) continue;

            try {
                if (!db.objectStoreNames.contains(storeName)) {
                    warnings.push(
                        `数据库 ${dbName} 缺少对象存储 ${storeName}（当前应用版本可能过旧），已跳过 ${storeData.length} 条记录`,
                    );
                    continue;
                }

                const skipped = await importStore(db, storeName, storeData, unzipped);
                if (skipped > 0) {
                    warnings.push(`${dbName}/${storeName}：${skipped} 条记录因备份中缺少图片数据被跳过`);
                }

                completedStores++;
                if (onProgress) {
                    const percent = 20 + Math.floor((completedStores / Math.max(totalStores, 1)) * 70);
                    onProgress({
                        percent,
                        message: `正在导入 ${dbName}/${storeName}...`,
                    });
                }
            } catch {
                warnings.push(`导入 ${dbName}/${storeName} 时出错，该部分数据可能不完整`);
            }
        }

        db.close();
    }

    return warnings;
}

/**
 * 从 ZIP 文件导入所有数据（覆盖现有数据）
 * 使用 fflate 在 Web Worker 中异步解压，兼容新版和旧版（JSZip 生成的）备份格式
 * @returns 警告信息列表（空数组表示完全成功）
 */
export async function importAllData(file: File, onProgress?: ProgressCallback): Promise<string[]> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导入数据...' });
    }

    // 解压 ZIP 文件
    if (onProgress) {
        onProgress({ percent: 5, message: '正在解压文件...' });
    }

    const buffer = await file.arrayBuffer();
    const unzipped = await unzipAsync(new Uint8Array(buffer));

    // 辅助：从解压结果读取文本
    const readText = (path: string): string | null => {
        const data = unzipped[path];
        return data ? new TextDecoder().decode(data) : null;
    };

    // 校验备份文件有效性，避免拿错 zip 时清空设置还提示成功
    const metadataText = readText('metadata.json');
    if (!metadataText) {
        throw new Error('不是有效的备份文件（缺少 metadata.json），请选择本应用导出的完整备份');
    }
    let metadata: Record<string, unknown>;
    try {
        metadata = JSON.parse(metadataText) as Record<string, unknown>;
    } catch {
        throw new Error('备份文件的 metadata.json 已损坏，无法导入');
    }
    if (metadata.incremental === true) {
        throw new Error('不支持导入非完整备份文件，请选择完整备份文件');
    }

    // 读取 localStorage 数据
    if (onProgress) {
        onProgress({ percent: 10, message: '正在清空 localStorage...' });
    }

    const localStorageText = readText('localStorage.json');

    // 读取 IndexedDB 数据与 schema
    const indexedDBData: IndexedDBBackup = {};
    let schema: DbSchema | undefined;
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('indexedDB/') && path.endsWith('.json')) {
            const dbName = path.replace('indexedDB/', '').replace('.json', '');
            if (dbName === 'schema') {
                try {
                    schema = JSON.parse(new TextDecoder().decode(data)) as DbSchema;
                } catch {
                    // schema 损坏时退回代码内已知定义
                }
                continue;
            }
            indexedDBData[dbName] = JSON.parse(new TextDecoder().decode(data));
        }
    }

    // 读取 localforage（无限画布）数据
    const localForageData: LocalForageBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('localforage/') && path.endsWith('.json')) {
            const dbName = path.replace('localforage/', '').replace('.json', '');
            localForageData[dbName] = JSON.parse(new TextDecoder().decode(data));
        }
    }

    if (!localStorageText && Object.keys(indexedDBData).length === 0 && Object.keys(localForageData).length === 0) {
        throw new Error('备份文件中没有可导入的数据，请确认选择的是完整备份');
    }

    const warnings: string[] = [];

    // 清空现有 localStorage（仅白名单键），再写入备份数据
    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch {
            // skip failed localStorage removal
        }
    }

    if (onProgress) {
        onProgress({ percent: 15, message: '正在导入 localStorage...' });
    }

    if (localStorageText) {
        try {
            importLocalStorage(JSON.parse(localStorageText));
        } catch {
            warnings.push('localStorage 数据解析失败，设置未被恢复');
        }
    }

    // 导入 IndexedDB
    warnings.push(...await importIndexedDB(indexedDBData, schema, unzipped, onProgress));

    // 导入 localforage（无限画布）数据
    if (onProgress) {
        onProgress({ percent: 92, message: '正在导入无限画布数据...' });
    }
    const lfSkipped = await importLocalForage(localForageData, unzipped);
    if (lfSkipped > 0) {
        warnings.push(`无限画布图片：${lfSkipped} 张因备份中缺少图片数据被跳过`);
    }

    if (onProgress) {
        onProgress({ percent: 100, message: '导入完成！' });
    }

    return warnings;
}

/**
 * 下载 Blob 为文件
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Safari 需要延迟撤销，否则下载可能失败
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `nova-backup-${dateStr}-${timeStr}.zip`;
}
