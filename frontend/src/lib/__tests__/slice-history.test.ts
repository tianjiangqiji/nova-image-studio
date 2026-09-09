import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SliceAsset, SliceWorkspaceDraft } from '@/lib/slice-types';

// slice-db 走 IndexedDB，在 jsdom 下不可用；历史栈逻辑与持久化无关，直接打桩。
const saveWorkspace = vi.fn(async (_draft: SliceWorkspaceDraft) => {});
const deletedBlobs: string[] = [];

vi.mock('@/lib/slice-db', () => ({
  saveWorkspace: (draft: SliceWorkspaceDraft) => saveWorkspace(draft),
  listWorkspaces: async () => [],
  getWorkspace: async () => null,
  putBlob: async () => 'blob-key',
  deleteBlob: async (key: string) => {
    deletedBlobs.push(key);
  },
  deleteWorkspace: async () => {},
  copyWorkspace: async () => null,
}));

// store 内部用相对路径 import slice-db，vi.mock 的路径需与之解析到同一模块
vi.mock('../../../lib/slice-db', async () => await import('@/lib/slice-db'));

const { MAX_SLICE_HISTORY, collectLiveBlobKeys, selectCanRedo, selectCanUndo, selectUndoLabel, useSliceStore } =
  await import('@/components/slice/stores/use-slice-store');

function makeAsset(id: string, x = 0): SliceAsset {
  return {
    id,
    name: `切图 ${id}`,
    type: 'manual_slice',
    placement: { x, y: 0, width: 10, height: 10 },
    radius: 0,
    transparent: false,
    aiTransparent: false,
    aiCompleted: false,
    hidden: false,
    originalBlobKey: `orig-${id}`,
    currentBlobKey: `cur-${id}`,
  };
}

function seedWorkspace(assets: SliceAsset[] = []): SliceWorkspaceDraft {
  const draft: SliceWorkspaceDraft = {
    id: 'ws-1',
    note: '测试',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    screen: { width: 750, height: 1334 },
    sourceImageBlobKey: 'source-key',
    thumbnailBlobKey: null,
    assets,
  };
  useSliceStore.setState({
    activeWorkspaceId: draft.id,
    activeWorkspace: draft,
    workspaces: [draft],
    past: [],
    future: [],
  });
  return draft;
}

const assets = () => useSliceStore.getState().activeWorkspace?.assets ?? [];
const ids = () => assets().map((a) => a.id);

beforeEach(() => {
  saveWorkspace.mockClear();
  deletedBlobs.length = 0;
  useSliceStore.getState().endGesture();
  useSliceStore.setState({ activeWorkspaceId: null, activeWorkspace: null, workspaces: [], past: [], future: [] });
});

describe('commit', () => {
  it('records history and applies the change', async () => {
    seedWorkspace([makeAsset('a')]);
    await useSliceStore.getState().commit('新增切图', (d) => {
      d.assets.push(makeAsset('b'));
    });

    expect(ids()).toEqual(['a', 'b']);
    expect(selectCanUndo(useSliceStore.getState())).toBe(true);
    expect(selectUndoLabel(useSliceStore.getState())).toBe('新增切图');
  });

  it('is a no-op without an active workspace', async () => {
    await useSliceStore.getState().commit('无效', (d) => d.assets.push(makeAsset('x')));
    expect(useSliceStore.getState().past).toHaveLength(0);
  });
});

describe('undo / redo', () => {
  it('round-trips a single change', async () => {
    seedWorkspace([makeAsset('a')]);
    await useSliceStore.getState().commit('新增切图', (d) => d.assets.push(makeAsset('b')));

    await useSliceStore.getState().undo();
    expect(ids()).toEqual(['a']);
    expect(selectCanRedo(useSliceStore.getState())).toBe(true);

    await useSliceStore.getState().redo();
    expect(ids()).toEqual(['a', 'b']);
    expect(selectCanRedo(useSliceStore.getState())).toBe(false);
  });

  it('walks back and forward through several steps in order', async () => {
    seedWorkspace([]);
    const store = useSliceStore.getState();
    await store.commit('1', (d) => d.assets.push(makeAsset('a')));
    await store.commit('2', (d) => d.assets.push(makeAsset('b')));
    await store.commit('3', (d) => d.assets.push(makeAsset('c')));
    expect(ids()).toEqual(['a', 'b', 'c']);

    await store.undo();
    await store.undo();
    expect(ids()).toEqual(['a']);

    await store.redo();
    expect(ids()).toEqual(['a', 'b']);
    await store.redo();
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('restores deleted assets intact, including their blob keys', async () => {
    // 这是「撤销删除后图片仍可用」的回归防线：blob key 必须原样回来
    seedWorkspace([makeAsset('a'), makeAsset('b')]);
    await useSliceStore.getState().commit('删除切图', (d) => {
      d.assets = d.assets.filter((x) => x.id !== 'a');
    });
    expect(ids()).toEqual(['b']);

    await useSliceStore.getState().undo();
    expect(ids()).toEqual(['a', 'b']);
    expect(assets()[0].originalBlobKey).toBe('orig-a');
    expect(assets()[0].currentBlobKey).toBe('cur-a');
  });

  it('clears the redo stack once a new change lands', async () => {
    seedWorkspace([]);
    const store = useSliceStore.getState();
    await store.commit('1', (d) => d.assets.push(makeAsset('a')));
    await store.undo();
    expect(selectCanRedo(useSliceStore.getState())).toBe(true);

    await store.commit('2', (d) => d.assets.push(makeAsset('z')));
    expect(selectCanRedo(useSliceStore.getState())).toBe(false);
    expect(ids()).toEqual(['z']);
  });

  it('does nothing when the stacks are empty', async () => {
    seedWorkspace([makeAsset('a')]);
    await useSliceStore.getState().undo();
    expect(ids()).toEqual(['a']);
    await useSliceStore.getState().redo();
    expect(ids()).toEqual(['a']);
  });

  it('snapshots are decoupled from live state', async () => {
    // 快照必须是深拷贝，否则后续就地修改会污染历史
    seedWorkspace([makeAsset('a', 0)]);
    await useSliceStore.getState().commit('移动', (d) => {
      d.assets[0].placement.x = 500;
    });
    expect(assets()[0].placement.x).toBe(500);
    await useSliceStore.getState().undo();
    expect(assets()[0].placement.x).toBe(0);
  });
});

describe('history cap', () => {
  it(`keeps at most ${MAX_SLICE_HISTORY} entries and still undoes correctly`, async () => {
    seedWorkspace([]);
    const store = useSliceStore.getState();
    for (let i = 0; i < MAX_SLICE_HISTORY + 12; i += 1) {
      await store.commit(`step-${i}`, (d) => d.assets.push(makeAsset(`a${i}`)));
    }
    expect(useSliceStore.getState().past).toHaveLength(MAX_SLICE_HISTORY);
    // 最早的记录被丢弃，但栈顶仍然是最近一次
    expect(selectUndoLabel(useSliceStore.getState())).toBe(`step-${MAX_SLICE_HISTORY + 11}`);
    await store.undo();
    expect(ids()).toHaveLength(MAX_SLICE_HISTORY + 11);
  });
});

describe('beginGesture / endGesture', () => {
  it('records one entry for a whole drag', async () => {
    seedWorkspace([makeAsset('a', 0)]);
    const store = useSliceStore.getState();

    store.beginGesture('移动切图');
    // 拖拽过程中的多次落地（模拟 pointermove → pointerup 的多段写入）
    await store.updateActiveWorkspace((d) => {
      d.assets[0].placement.x = 100;
    });
    store.beginGesture('移动切图'); // 手势期间重复调用应被忽略
    await store.updateActiveWorkspace((d) => {
      d.assets[0].placement.x = 200;
    });
    store.endGesture();

    expect(useSliceStore.getState().past).toHaveLength(1);
    await store.undo();
    expect(assets()[0].placement.x).toBe(0);
  });

  it('records again after the gesture ends', async () => {
    seedWorkspace([makeAsset('a')]);
    const store = useSliceStore.getState();
    store.beginGesture('第一次拖拽');
    store.endGesture();
    store.beginGesture('第二次拖拽');
    store.endGesture();
    expect(useSliceStore.getState().past).toHaveLength(2);
  });
});

describe('mergeCommit', () => {
  it('merges rapid edits under the same key into one entry', async () => {
    seedWorkspace([makeAsset('a', 0)]);
    const store = useSliceStore.getState();
    await store.mergeCommit('width:a', '修改宽度', (d) => {
      d.assets[0].placement.width = 20;
    });
    await store.mergeCommit('width:a', '修改宽度', (d) => {
      d.assets[0].placement.width = 30;
    });
    await store.mergeCommit('width:a', '修改宽度', (d) => {
      d.assets[0].placement.width = 40;
    });

    expect(useSliceStore.getState().past).toHaveLength(1);
    expect(assets()[0].placement.width).toBe(40);
    await store.undo();
    expect(assets()[0].placement.width).toBe(10);
  });

  it('starts a new entry for a different key', async () => {
    seedWorkspace([makeAsset('a')]);
    const store = useSliceStore.getState();
    await store.mergeCommit('width:a', '修改宽度', (d) => {
      d.assets[0].placement.width = 20;
    });
    await store.mergeCommit('height:a', '修改高度', (d) => {
      d.assets[0].placement.height = 20;
    });
    expect(useSliceStore.getState().past).toHaveLength(2);
  });

  it('starts a new entry once the merge window has passed', async () => {
    vi.useFakeTimers();
    try {
      seedWorkspace([makeAsset('a')]);
      const store = useSliceStore.getState();
      await store.mergeCommit('width:a', '修改宽度', (d) => {
        d.assets[0].placement.width = 20;
      });
      vi.advanceTimersByTime(1200);
      await store.mergeCommit('width:a', '修改宽度', (d) => {
        d.assets[0].placement.width = 30;
      });
      expect(useSliceStore.getState().past).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is interrupted by a plain commit', async () => {
    seedWorkspace([makeAsset('a')]);
    const store = useSliceStore.getState();
    await store.mergeCommit('width:a', '修改宽度', (d) => {
      d.assets[0].placement.width = 20;
    });
    await store.commit('删除切图', (d) => {
      d.assets = [];
    });
    await store.mergeCommit('width:a', '修改宽度', (d) => {
      d.assets.push(makeAsset('b'));
    });
    expect(useSliceStore.getState().past).toHaveLength(3);
  });
});

describe('applySilent', () => {
  it('changes state without touching history', async () => {
    seedWorkspace([makeAsset('a')]);
    await useSliceStore.getState().applySilent((d) => {
      d.assets[0].currentBlobKey = 'recropped';
    });
    expect(assets()[0].currentBlobKey).toBe('recropped');
    expect(useSliceStore.getState().past).toHaveLength(0);
  });
});

describe('workspace switching', () => {
  it('clears both stacks on close', async () => {
    seedWorkspace([makeAsset('a')]);
    await useSliceStore.getState().commit('新增', (d) => d.assets.push(makeAsset('b')));
    useSliceStore.getState().closeWorkspace();
    const state = useSliceStore.getState();
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(state.activeWorkspace).toBeNull();
  });
});

describe('collectLiveBlobKeys', () => {
  it('includes the source, thumbnail, current assets, and every history snapshot', () => {
    const draft = seedWorkspace([makeAsset('a')]);
    draft.thumbnailBlobKey = 'thumb-key';
    const keys = collectLiveBlobKeys(
      draft,
      [{ assets: [makeAsset('deleted')], label: '删除' }],
      [{ assets: [makeAsset('redo')], label: '重做' }],
    );
    expect(keys).toContain('source-key');
    expect(keys).toContain('thumb-key');
    expect(keys).toContain('orig-a');
    expect(keys).toContain('cur-a');
    // 历史栈里被删掉的资产的 blob 也必须算存活，否则撤销会得到空图
    expect(keys).toContain('orig-deleted');
    expect(keys).toContain('orig-redo');
  });

  it('covers the derived blob keys', () => {
    const asset = makeAsset('a');
    asset.transparentBlobKey = 'tr-a';
    asset.aiTransparentBlobKey = 'ai-a';
    asset.repairBlobKey = 'rp-a';
    const draft = seedWorkspace([asset]);
    const keys = collectLiveBlobKeys(draft, [], []);
    expect(keys).toContain('tr-a');
    expect(keys).toContain('ai-a');
    expect(keys).toContain('rp-a');
  });

  it('keeps process snapshot blobs live while closing a workspace', () => {
    const asset = makeAsset('a');
    asset.processSnapshots = { transparent: { currentBlobKey: 'snapshot-a', transparent: false, aiTransparent: false } };
    const keys = collectLiveBlobKeys(seedWorkspace([asset]), [], []);
    expect(keys).toContain('snapshot-a');
  });

  it('collects discarded process snapshot blobs when closing a workspace', async () => {
    const draft = seedWorkspace([makeAsset('current')]);
    const old = makeAsset('old');
    old.processSnapshots = { transparent: { currentBlobKey: 'discarded-snapshot', transparent: false, aiTransparent: false } };
    useSliceStore.setState({ past: [{ assets: [old], label: '旧状态' }] });

    useSliceStore.getState().closeWorkspace();
    await Promise.resolve();

    expect(deletedBlobs).toContain('discarded-snapshot');
    expect(deletedBlobs).not.toContain(draft.sourceImageBlobKey);
  });
});
