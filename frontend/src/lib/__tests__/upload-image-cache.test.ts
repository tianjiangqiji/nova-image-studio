import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPLOAD_CACHE_MAX_BYTES,
  UPLOAD_CACHE_MAX_ENTRIES,
  getUploadCacheEvictionKeys,
} from '@/lib/upload-image-cache';

interface CachedRecord {
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

function cacheEntry(key: string, createdAt: number, processedSize: number) {
  return { key, createdAt, processedSize, dataUrl: '' };
}

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: Event) => void) | null = null;
}

interface FakeCacheState {
  records: Map<string, CachedRecord>;
  failNextPut: boolean;
}

class FakeTransaction {
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  private pending = 0;
  private aborted = false;
  private readonly snapshot: Map<string, CachedRecord>;

  constructor(private readonly state: FakeCacheState) {
    this.snapshot = new Map(state.records);
  }

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this, this.state);
  }

  enqueue<T>(request: FakeRequest<T>, operation: () => T): FakeRequest<T> {
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) return;
      try {
        request.result = operation();
        request.onsuccess?.({ target: request } as unknown as Event);
      } catch (error) {
        request.error = error as DOMException;
        request.onerror?.({ target: request } as unknown as Event);
        this.aborted = true;
        this.state.records = new Map(this.snapshot);
        queueMicrotask(() => {
          this.onerror?.({ target: this } as unknown as Event);
          this.onabort?.({ target: this } as unknown as Event);
        });
        return;
      } finally {
        this.pending -= 1;
      }
      if (this.pending === 0) {
        queueMicrotask(() => {
          if (!this.aborted && this.pending === 0) this.oncomplete?.({ target: this } as unknown as Event);
        });
      }
    });
    return request;
  }
}

class FakeObjectStore {
  constructor(private readonly transaction: FakeTransaction, private readonly state: FakeCacheState) {}

  get(key: string): FakeRequest<CachedRecord | undefined> {
    const request = new FakeRequest<CachedRecord | undefined>();
    return this.transaction.enqueue(request, () => this.state.records.get(key));
  }

  getAll(): FakeRequest<CachedRecord[]> {
    const request = new FakeRequest<CachedRecord[]>();
    return this.transaction.enqueue(request, () => [...this.state.records.values()]);
  }

  put(record: CachedRecord): FakeRequest<string> {
    const request = new FakeRequest<string>();
    return this.transaction.enqueue(request, () => {
      if (this.state.failNextPut) {
        this.state.failNextPut = false;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      this.state.records.set(record.key, record);
      return record.key;
    });
  }

  delete(key: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    return this.transaction.enqueue(request, () => {
      this.state.records.delete(key);
      return undefined;
    });
  }
}

function createFakeIndexedDB(records: CachedRecord[] = []) {
  const state: FakeCacheState = { records: new Map(records.map(record => [record.key, record])), failNextPut: false };
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => new FakeTransaction(state),
    createObjectStore: vi.fn(),
    close: vi.fn(),
    onversionchange: null,
    onclose: null,
  };
  const factory = {
    open: () => {
      const request = new FakeRequest<IDBDatabase>();
      queueMicrotask(() => {
        request.result = database as unknown as IDBDatabase;
        request.onsuccess?.({ target: request } as unknown as Event);
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, state };
}

function fullCacheEntry(key: string, createdAt: number): CachedRecord {
  return {
    key,
    name: `${key}.png`,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,eA==',
    originalSize: 1,
    processedSize: 1,
    width: 1,
    height: 1,
    createdAt,
  };
}

function makeFile(name: string): File {
  const file = new File(['x'], name, { type: 'image/png' });
  if (!file.arrayBuffer) {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1]).buffer,
    });
  }
  return file;
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1;
  naturalHeight = 1;
  width = 1;
  height = 1;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe('upload image cache limits', () => {
  it('uses conservative explicit count and byte ceilings', () => {
    expect(UPLOAD_CACHE_MAX_ENTRIES).toBe(32);
    expect(UPLOAD_CACHE_MAX_BYTES).toBe(96 * 1024 * 1024);
  });

  it('evicts oldest createdAt entries when count exceeds the ceiling', () => {
    const records = Array.from({ length: 34 }, (_, index) =>
      cacheEntry(`entry-${index}`, index, 1),
    ).reverse();

    expect(getUploadCacheEvictionKeys(records)).toEqual(['entry-0', 'entry-1']);
  });

  it('evicts oldest createdAt entries until total bytes fit', () => {
    const records = [
      cacheEntry('newest', 4, 48 * 1024 * 1024),
      cacheEntry('older', 2, 32 * 1024 * 1024),
      cacheEntry('oldest', 1, 32 * 1024 * 1024),
      cacheEntry('middle', 3, 32 * 1024 * 1024),
    ];

    expect(getUploadCacheEvictionKeys(records)).toEqual(['oldest', 'older']);
  });

  it('never keeps an older entry after evicting a newer oversized entry', () => {
    const records = [
      cacheEntry('oldest-small', 1, 1),
      cacheEntry('middle-large', 2, UPLOAD_CACHE_MAX_BYTES),
      cacheEntry('newest-small', 3, 1),
    ];

    expect(getUploadCacheEvictionKeys(records)).toEqual(['oldest-small', 'middle-large']);
  });
});

describe('upload image cache writes', () => {
  let digest = 255;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array([digest]).buffer),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prunes the oldest persisted entry after saving the current upload', async () => {
    const existing = Array.from({ length: UPLOAD_CACHE_MAX_ENTRIES }, (_, index) => fullCacheEntry(`old-${index}`, index));
    const fake = createFakeIndexedDB(existing);
    vi.stubGlobal('indexedDB', fake.factory);
    const { prepareUploadImage } = await import('@/lib/upload-image-cache');

    const result = await prepareUploadImage(makeFile('current.png'));

    expect(result.cacheHit).toBe(false);
    expect(fake.state.records.size).toBe(UPLOAD_CACHE_MAX_ENTRIES);
    expect(fake.state.records.has(result.id)).toBe(true);
    expect(fake.state.records.has('old-0')).toBe(false);
  });

  it('refreshes createdAt on a cache hit', async () => {
    digest = 1;
    const cached = fullCacheEntry('01', 1);
    const fake = createFakeIndexedDB([cached]);
    vi.stubGlobal('indexedDB', fake.factory);
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { prepareUploadImage } = await import('@/lib/upload-image-cache');

    const result = await prepareUploadImage(makeFile('cached.png'));

    expect(result.cacheHit).toBe(true);
    expect(fake.state.records.get('01')?.createdAt).toBe(100);
  });

  it('retries a quota-aborted write after evicting older entries and keeps the current upload', async () => {
    const fake = createFakeIndexedDB([fullCacheEntry('old', 1)]);
    fake.state.failNextPut = true;
    vi.stubGlobal('indexedDB', fake.factory);
    const { prepareUploadImage } = await import('@/lib/upload-image-cache');

    const result = await prepareUploadImage(makeFile('current.png'));

    expect(result.cacheHit).toBe(false);
    expect([...fake.state.records.keys()]).toEqual([result.id]);
  });
});
