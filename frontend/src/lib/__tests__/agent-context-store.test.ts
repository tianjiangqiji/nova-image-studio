import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeKey = string | number;

type FakeState = {
  name: string;
  stores: Map<string, Map<FakeKey, unknown>>;
  connections: Set<FakeDatabase>;
  operations: string[];
};

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class FakeTransaction {
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private pending = 0;

  constructor(private readonly database: FakeDatabase, private readonly storeNames: string[]) {}

  objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) throw new Error(`Store not in transaction: ${name}`);
    return new FakeObjectStore(this, this.database.state, name);
  }

  enqueue<T>(request: FakeRequest<T>, operation: () => T): FakeRequest<T> {
    this.pending += 1;
    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.({ target: request } as unknown as Event);
      } catch (error) {
        request.error = error as DOMException;
        request.onerror?.({ target: request } as unknown as Event);
      } finally {
        this.pending -= 1;
        if (this.pending === 0) {
          queueMicrotask(() => this.oncomplete?.({ target: this } as unknown as Event));
        }
      }
    });
    return request;
  }
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly state: FakeState,
    private readonly name: string,
  ) {}

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    return this.transaction.enqueue(request, () => Array.from(this.store().values()));
  }

  getAllKeys(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    return this.transaction.enqueue(request, () => Array.from(this.store().keys()));
  }

  get(key: FakeKey): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    return this.transaction.enqueue(request, () => this.store().get(key));
  }

  put(value: unknown): FakeRequest<FakeKey> {
    const request = new FakeRequest<FakeKey>();
    return this.transaction.enqueue(request, () => {
      const keyPath = this.name === 'messages' ? 'id' : this.name === 'images' ? 'imgId' : 'key';
      const key = (value as Record<string, unknown>)[keyPath];
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new Error(`Missing key path: ${keyPath}`);
      }
      this.store().set(key, value);
      return key;
    });
  }

  delete(key: FakeKey): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    return this.transaction.enqueue(request, () => {
      this.state.operations.push(`${this.state.name}:${this.name}:delete:${key}`);
      this.store().delete(key);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    return this.transaction.enqueue(request, () => {
      this.state.operations.push(`${this.state.name}:${this.name}:clear`);
      this.store().clear();
      return undefined;
    });
  }

  private store(): Map<FakeKey, unknown> {
    const store = this.state.stores.get(this.name);
    if (!store) throw new Error(`Unknown store: ${this.name}`);
    return store;
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.state.stores.has(name),
  } as unknown as DOMStringList;
  onversionchange: ((event: IDBVersionChangeEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  closed = false;
  closeCount = 0;

  constructor(readonly state: FakeState) {
    state.connections.add(this);
  }

  createObjectStore(name: string): void {
    this.state.stores.set(name, new Map());
  }

  transaction(storeNames: string | string[]): FakeTransaction {
    return new FakeTransaction(this, Array.isArray(storeNames) ? storeNames : [storeNames]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
    this.state.connections.delete(this);
  }
}

function createFakeIndexedDB() {
  const states = new Map<string, FakeState>();
  const openCalls: string[] = [];
  const deleteCalls: string[] = [];
  const operations: string[] = [];

  const factory = {
    open(name: string): FakeRequest<IDBDatabase> {
      openCalls.push(name);
      const request = new FakeRequest<IDBDatabase>();
      queueMicrotask(() => {
        let state = states.get(name);
        const isNew = !state;
        if (!state) {
          state = { name, stores: new Map(), connections: new Set(), operations };
          states.set(name, state);
        }
        const database = new FakeDatabase(state);
        request.result = database as unknown as IDBDatabase;
        if (isNew) request.onupgradeneeded?.({ target: request } as unknown as Event);
        request.onsuccess?.({ target: request } as unknown as Event);
      });
      return request;
    },

    deleteDatabase(name: string): FakeRequest<undefined> {
      deleteCalls.push(name);
      const request = new FakeRequest<undefined>();
      queueMicrotask(() => {
        const state = states.get(name);
        if (state && state.connections.size > 0) {
          request.onblocked?.({ target: request } as unknown as Event);
          request.error = new DOMException('blocked', 'InvalidStateError');
          request.onerror?.({ target: request } as unknown as Event);
          return;
        }
        states.delete(name);
        request.onsuccess?.({ target: request } as unknown as Event);
      });
      return request;
    },
  } as unknown as IDBFactory;

  return { factory, openCalls, deleteCalls, operations, states };
}

function message(id: string, createdAt: number) {
  return { id, role: 'user' as const, text: id, createdAt };
}

function imageRecord(imgId: string, createdAt: number) {
  return {
    imgId,
    source: 'generated' as const,
    thumbnail: '',
    description: imgId,
    mimeType: 'text/plain',
    createdAt,
  };
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('agent-context-store session databases', () => {
  let store: typeof import('@/lib/agent-context-store');
  let fakeIndexedDB: ReturnType<typeof createFakeIndexedDB>;

  beforeEach(async () => {
    vi.resetModules();
    fakeIndexedDB = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fakeIndexedDB.factory);
    store = await import('@/lib/agent-context-store');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('默认会话沿用 nova-agent-db，切换后现有 API 按会话隔离', async () => {
    await store.putMessage(message('default-message', 1));
    expect(fakeIndexedDB.openCalls).toEqual(['nova-agent-db']);

    store.setAgentSession('review');
    expect((await store.loadAgentSession()).messages).toEqual([]);

    await store.putMessage(message('review-message', 2));
    store.setAgentSession('default');
    expect((await store.loadAgentSession()).messages.map(item => item.id)).toEqual(['default-message']);

    store.setAgentSession('review');
    expect((await store.loadAgentSession()).messages.map(item => item.id)).toEqual(['review-message']);
    expect(fakeIndexedDB.openCalls).toEqual(['nova-agent-db', 'nova-agent-db-review']);
  });

  it('删除非默认会话前关闭缓存句柄，并拒绝删除默认数据库', async () => {
    store.setAgentSession('review');
    await store.putMessage(message('review-message', 1));
    const reviewDb = Array.from(fakeIndexedDB.states.get('nova-agent-db-review')!.connections)[0];

    await store.deleteAgentSessionDatabase('review');

    expect(reviewDb.closeCount).toBe(1);
    expect(fakeIndexedDB.deleteCalls).toEqual(['nova-agent-db-review']);
    expect((await store.loadAgentSession()).messages).toEqual([]);

    await expect(store.deleteAgentSessionDatabase('default')).rejects.toThrow(/默认会话数据库不可删除/);
    expect(fakeIndexedDB.deleteCalls).toEqual(['nova-agent-db-review']);
  });

  it('延迟执行的旧会话写入仍固定到显式 sessionId', async () => {
    store.setAgentSession('old');
    const delayedWrite = Promise.resolve().then(() =>
      store.putMessage(message('old-message', 1), 'old'),
    );
    store.setAgentSession('new');

    await delayedWrite;

    expect((await store.loadAgentSession('old')).messages.map(item => item.id)).toEqual(['old-message']);
    expect((await store.loadAgentSession('new')).messages).toEqual([]);
  });

  it('非默认会话使用独立的 img blob 命名空间', async () => {
    await store.putImageRecord(imageRecord('img_1', 1), 'alpha');
    await store.storeAgentImageBytes('img_1', new Blob(['alpha'], { type: 'text/plain' }), 'alpha');
    await store.putImageRecord(imageRecord('img_1', 2), 'beta');
    await store.storeAgentImageBytes('img_1', new Blob(['beta'], { type: 'text/plain' }), 'beta');

    const alphaBlob = await store.getAgentImageBytes('img_1', 'alpha');
    const betaBlob = await store.getAgentImageBytes('img_1', 'beta');

    expect(alphaBlob).not.toBeNull();
    expect(betaBlob).not.toBeNull();
    expect(await readBlobText(alphaBlob!)).toBe('alpha');
    expect(await readBlobText(betaBlob!)).toBe('beta');
  });

  it('删除会话时清理其 blob，而不会影响另一个会话', async () => {
    await store.putImageRecord(imageRecord('img_1', 1), 'alpha');
    await store.storeAgentImageBytes('img_1', new Blob(['alpha'], { type: 'text/plain' }), 'alpha');
    await store.putImageRecord(imageRecord('img_1', 2), 'beta');
    await store.storeAgentImageBytes('img_1', new Blob(['beta'], { type: 'text/plain' }), 'beta');

    await store.deleteAgentSessionDatabase('alpha');

    expect(await store.getAgentImageBytes('img_1', 'alpha')).toBeNull();
    const betaBlob = await store.getAgentImageBytes('img_1', 'beta');
    expect(betaBlob).not.toBeNull();
    expect(await readBlobText(betaBlob!)).toBe('beta');
  });

  it('删除会话被阻塞时返回失败并保留原会话图片', async () => {
    await store.putMessage(message('blocked-message', 1), 'blocked');
    await store.putImageRecord(imageRecord('img_1', 1), 'blocked');
    await store.storeAgentImageBytes('img_1', new Blob(['blocked'], { type: 'text/plain' }), 'blocked');
    const extraRequest = fakeIndexedDB.factory.open('nova-agent-db-blocked');
    const extraConnection = await new Promise<FakeDatabase>((resolve) => {
      extraRequest.onsuccess = () => resolve(extraRequest.result as unknown as FakeDatabase);
    });

    await expect(store.deleteAgentSessionDatabase('blocked')).rejects.toThrow(/blocked/i);
    const retainedBlob = await store.getAgentImageBytes('img_1', 'blocked');
    expect(retainedBlob).not.toBeNull();
    expect(await readBlobText(retainedBlob!)).toBe('blocked');
    extraConnection.close();
  });

  it('启动清扫删除孤儿 agent blob，存活登记与任务结果 blob 不受影响', async () => {
    const downloader = await import('@/lib/image-downloader');
    // 存活：默认会话已登记的 img_1
    await store.putImageRecord(imageRecord('img_1', 1));
    await store.storeAgentImageBytes('img_1', new Blob(['live'], { type: 'text/plain' }));
    // 孤儿：默认命名空间里无登记记录的 img_99（登记流程中断残留）
    await store.storeAgentImageBytes('img_99', new Blob(['orphan-default'], { type: 'text/plain' }));
    // 孤儿：已删除会话残留的命名空间 blob
    await downloader.storeImageBlob('agent-session-deadsession-img_1', 0, new Blob(['orphan-session'], { type: 'text/plain' }));
    // 任务结果 blob：uuid 命名空间，不属于 Agent，绝不能被清扫
    await downloader.storeImageBlob('5dae2cfa-019e-4df1-9161-c3ba0a3b1629', 0, new Blob(['task'], { type: 'text/plain' }));

    const removed = await store.sweepAgentOrphanBlobs();

    expect(removed).toBe(2);
    expect(await store.getAgentImageBytes('img_1')).not.toBeNull();
    expect(await store.getAgentImageBytes('img_99')).toBeNull();
    expect(await downloader.getStoredBlob('agent-session-deadsession-img_1', 0)).toBeNull();
    const taskBlob = await downloader.getStoredBlob('5dae2cfa-019e-4df1-9161-c3ba0a3b1629', 0);
    expect(taskBlob).not.toBeNull();
    expect(await readBlobText(taskBlob!)).toBe('task');
  });

  it('远程图片下载在 clear 后完成时不写回 blob cache', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchPromise = new Promise<Response>(resolve => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => fetchPromise));
    const record = {
      ...imageRecord('img_1', 1),
      remoteUrl: 'https://example.test/late.png',
    };
    await store.putImageRecord(record, 'remote');
    const generation = store.getAgentSessionGeneration('remote');

    const pending = store.getAgentImageBase64('img_1', 'remote', generation);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(record.remoteUrl));
    await store.clearAgentSession('remote');
    resolveFetch(new Response(new Blob(['late'], { type: 'image/png' })));
    await pending;

    expect(await store.getAgentImageBytes('img_1', 'remote')).toBeNull();
    expect((await store.loadAgentSession('remote')).images).toEqual([]);
  });

  it('远程参考图失效时抛出明确错误，不静默返回空参考图', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const record = {
      ...imageRecord('img_1', 1),
      remoteUrl: '/api/nova/cdp/products/missing.jpg',
    };
    await store.putImageRecord(record, 'remote-failure');

    await expect(store.getAgentImageBase64('img_1', 'remote-failure')).rejects.toThrow(/参考图下载失败.*HTTP 404/);
  });

  it('clear 先失效旧 generation，旧消息和图片写入不能复活会话', async () => {
    const generation = store.getAgentSessionGeneration('clear-race');
    await store.putMessage(message('before', 1), 'clear-race', generation);
    await store.putImageRecord(imageRecord('img_1', 1), 'clear-race', generation);
    await store.storeAgentImageBytes('img_1', new Blob(['before']), 'clear-race', generation);

    await store.clearAgentSession('clear-race');
    await store.putMessage(message('late', 2), 'clear-race', generation);
    await store.putImageRecord(imageRecord('img_1', 2), 'clear-race', generation);
    await store.storeAgentImageBytes('img_1', new Blob(['late']), 'clear-race', generation);

    expect(await store.loadAgentSession('clear-race')).toEqual({ messages: [], images: [], imageModel: null });
    expect(await store.getAgentImageBytes('img_1', 'clear-race')).toBeNull();
  });

  it('clear 在删除图片字节前先清空会话记录', async () => {
    await store.putImageRecord(imageRecord('img_1', 1), 'clear-order');
    await store.storeAgentImageBytes('img_1', new Blob(['bytes']), 'clear-order');
    fakeIndexedDB.operations.length = 0;

    await store.clearAgentSession('clear-order');

    const recordsCleared = fakeIndexedDB.operations.indexOf('nova-agent-db-clear-order:images:clear');
    const bytesDeleted = fakeIndexedDB.operations.indexOf('nova-image-db:blobs:delete:agent-session-clear-order-img_1-0');
    expect(recordsCleared).toBeGreaterThanOrEqual(0);
    expect(bytesDeleted).toBeGreaterThan(recordsCleared);
  });

  it('只回收精确且未被消息引用的图片记录', async () => {
    const orphan = imageRecord('img_1', 1);
    await store.putImageRecord(orphan, 'cleanup');
    await store.storeAgentImageBytes(orphan.imgId, new Blob(['orphan']), 'cleanup');
    expect(await store.deleteAgentImageIfUnreferenced(orphan, 'cleanup')).toBe(true);
    expect(await store.getAgentImageBytes(orphan.imgId, 'cleanup')).toBeNull();

    const live = imageRecord('img_2', 2);
    await store.putImageRecord(live, 'cleanup');
    await store.storeAgentImageBytes(live.imgId, new Blob(['live']), 'cleanup');
    await store.putMessage({ ...message('owner', 3), imageIds: [live.imgId] }, 'cleanup');
    expect(await store.deleteAgentImageIfUnreferenced(live, 'cleanup')).toBe(false);
    expect((await store.loadAgentSession('cleanup')).images.map(item => item.imgId)).toEqual(['img_2']);
    expect(await store.getAgentImageBytes(live.imgId, 'cleanup')).not.toBeNull();
  });

  it('旧 generation cleanup 不删除同 imgId 的新记录和新 blob', async () => {
    const oldGeneration = store.getAgentSessionGeneration('reuse');
    const record = imageRecord('img_1', 1);
    await store.putImageRecord(record, 'reuse', oldGeneration);
    await store.storeAgentImageBytes(record.imgId, new Blob(['old']), 'reuse', oldGeneration);
    await store.clearAgentSession('reuse');

    const newGeneration = store.getAgentSessionGeneration('reuse');
    const newRecord = { ...record };
    await store.putImageRecord(newRecord, 'reuse', newGeneration);
    await store.storeAgentImageBytes(newRecord.imgId, new Blob(['new']), 'reuse', newGeneration);
    expect(await store.deleteAgentImageIfUnreferenced(record, 'reuse', oldGeneration)).toBe(false);

    expect((await store.loadAgentSession('reuse')).images.map(item => item.imgId)).toEqual(['img_1']);
    const blob = await store.getAgentImageBytes(record.imgId, 'reuse');
    expect(blob).not.toBeNull();
    expect(await readBlobText(blob!)).toBe('new');
  });

  it('迁移旧单任务记录，并按 taskId 独立保存和删除待恢复任务', async () => {
    await store.loadAgentSession('tasks');
    const meta = fakeIndexedDB.states.get('nova-agent-db-tasks')!.stores.get('meta')!;
    const legacyTask: import('@/lib/agent-context-store').PendingGenerationData = {
      taskId: 'legacy-task',
      proposal: { action: 'generate', prompt: '旧任务', referencedImageIds: [], reason: '旧提案' },
      pendingAnalysis: '旧分析',
      pendingReasoning: '',
      selectedImageIds: [],
      model: 'image-model',
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      parallelCount: 1,
      startedAt: 1,
    };
    meta.set('pendingGeneration', { key: 'pendingGeneration', value: JSON.stringify(legacyTask) });

    expect(await store.loadPendingGenerationTasks('tasks')).toEqual([legacyTask]);
    await vi.waitFor(() => expect(JSON.parse((meta.get('pendingGeneration') as { value: string }).value)).toEqual({
      version: 2,
      tasks: { 'legacy-task': legacyTask },
    }));

    const newerTask = { ...legacyTask, taskId: 'newer-task', proposal: { ...legacyTask.proposal, prompt: '新任务' }, startedAt: 2 };
    await store.savePendingGenerationTask(newerTask, 'tasks');
    expect(await store.loadPendingGenerationTasks('tasks')).toEqual([legacyTask, newerTask]);

    await store.removePendingGenerationTask('legacy-task', 'tasks');
    expect(await store.loadPendingGenerationTasks('tasks')).toEqual([newerTask]);
  });
});
