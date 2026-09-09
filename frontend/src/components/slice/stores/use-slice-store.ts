// 图片切图工作区状态管理
// 参考 use-canvas-store.ts 的模式，但数据持久化在 IndexedDB（slice-db），
// 不使用 zustand persist 中间件，手动管理 hydrate 与防抖保存。
//
// 撤销/重做：历史栈放在 store 而不是组件，理由有三 ——
//   1. 所有变更本来就经过 updateActiveWorkspace 这一个漏斗；
//   2. SliceWorkspaceDraft 是纯 JSON（图片按 blob key 引用），structuredClone 很便宜；
//   3. 历史应随 workspace 走，而 SliceEditor 会因切换 workspace 而重挂载。
// 快照只存 assets：screen / sourceImageBlobKey / note 都不由编辑操作改变。

import { create } from 'zustand';
import { nanoid } from 'nanoid';

import {
  copyWorkspace as copyWorkspaceDb,
  deleteBlob,
  deleteWorkspace as deleteWorkspaceDb,
  getWorkspace,
  listWorkspaces,
  putBlob,
  saveWorkspace,
} from '../../../lib/slice-db';
import type {
  SliceAsset,
  SliceScreen,
  SliceWorkspaceDraft,
  WebAgentMessage,
  WebAgentUsageSnapshot,
} from '../../../lib/slice-types';

/** 历史栈上限。与 canvas 的 MAX_HISTORY 对齐。 */
export const MAX_SLICE_HISTORY = 50;

/** 同一 mergeKey 的连续提交在此窗口内合并为一条历史（属性面板数字连打）。 */
const MERGE_WINDOW_MS = 800;

/** 一条历史记录。label 用于按钮 tooltip 显示"将撤销：xxx"。 */
export interface SliceHistoryEntry {
  assets: SliceAsset[];
  label: string;
  mergeKey?: string;
}

export type SliceStore = {
  /** 是否已完成首次 hydrate */
  hydrated: boolean;
  /** 工作区列表（按 updatedAt 降序） */
  workspaces: SliceWorkspaceDraft[];
  /** 当前打开的工作区 id */
  activeWorkspaceId: string | null;
  /** 当前打开的工作区完整数据 */
  activeWorkspace: SliceWorkspaceDraft | null;

  /** 撤销栈（栈顶为最近一次变更之前的状态） */
  past: SliceHistoryEntry[];
  /** 重做栈 */
  future: SliceHistoryEntry[];

  /** 从 slice-db 加载 workspaces 列表，设 hydrated=true */
  hydrate: () => Promise<void>;
  /** 用 putBlob 存源图，创建新 workspace，保存并设为 active，返回 id */
  createWorkspace: (sourceImageBlob: Blob, screen: SliceScreen) => Promise<string>;
  /** 读取工作区并设为 active（清空历史栈） */
  openWorkspace: (id: string) => Promise<void>;
  /** 清空 active（清空历史栈，并回收孤儿 Blob） */
  closeWorkspace: () => void;
  /** 更新工作区备注 */
  updateWorkspaceNote: (id: string, note: string) => Promise<void>;
  /** 删除工作区并刷新列表，如果是 active 则 closeWorkspace */
  deleteWorkspace: (id: string) => Promise<void>;
  /** 深拷贝工作区，刷新列表 */
  copyWorkspace: (id: string) => Promise<void>;
  /** 不可变更新 active workspace 并防抖保存（400ms）。不记历史，内部使用。 */
  updateActiveWorkspace: (updater: (draft: SliceWorkspaceDraft) => void) => Promise<void>;
  /** 获取当前工作区 */
  getActiveWorkspace: () => SliceWorkspaceDraft | null;

  // ===== 历史栈 API =====

  /** 记一条历史后执行变更。这是编辑操作的标准入口。 */
  commit: (label: string, updater: (draft: SliceWorkspaceDraft) => void) => Promise<void>;
  /**
   * 同 mergeKey 且在 800ms 内的连续提交合并为一条历史。
   * 用于属性面板数字输入连打，避免每次按键一条历史。
   */
  mergeCommit: (
    mergeKey: string,
    label: string,
    updater: (draft: SliceWorkspaceDraft) => void,
  ) => Promise<void>;
  /** 手势开始时记一条历史（整段拖拽只记一次）。 */
  beginGesture: (label: string) => void;
  /** 手势结束，允许下一次 beginGesture 再记。 */
  endGesture: () => void;
  /** 不入历史的派生更新（重裁剪写回 blobKey 等）。 */
  applySilent: (updater: (draft: SliceWorkspaceDraft) => void) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** @deprecated 旧单文件产物，仅保留给历史数据清理用；新代码请用 setReplicaFiles */
  setReconstructedHtml: (html: string | null) => Promise<void>;
  /** 保存网页复刻的三文件产物，null 表示清除 */
  setReplicaFiles: (files: SliceWorkspaceDraft['replicaFiles']) => Promise<void>;
  /** 保存网页复刻 agent 的对话历史 */
  setWebAgentMessages: (messages: WebAgentMessage[]) => Promise<void>;
  /** 记录最近一次 API 回报的用量，作为上下文计数的权威值 */
  setWebAgentUsage: (usage: WebAgentUsageSnapshot | null) => Promise<void>;
  /** 清理对话：清空历史与上下文计数，但保留已生成的网页文件 */
  clearWebAgentConversation: () => Promise<void>;
};

// 防抖保存定时器，参考 use-canvas-store.ts 的 saveTimer 模式
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// 手势期间为 true，使整段拖拽只产生一条历史。对齐 CanvasEditor 的 gestureActive ref。
let gestureActive = false;
// 上一次 mergeCommit 的 key 与时间戳
let lastMerge: { key: string; at: number } | null = null;

/** 立即写库（撤销/重做/关闭时用，不能等防抖）。 */
function flushSave(draft: SliceWorkspaceDraft): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void saveWorkspace(draft);
}

/** 防抖写库。 */
function scheduleSave(draft: SliceWorkspaceDraft): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveWorkspace(draft);
  }, 400);
}

/** 深拷贝 assets 作为快照。图片是 blob key，不进快照，因此很便宜。 */
function snapshotAssets(draft: SliceWorkspaceDraft): SliceAsset[] {
  return structuredClone(draft.assets);
}

/** push 到 past 并按上限截断。 */
function pushPast(past: SliceHistoryEntry[], entry: SliceHistoryEntry): SliceHistoryEntry[] {
  const next = [...past, entry];
  return next.length > MAX_SLICE_HISTORY ? next.slice(next.length - MAX_SLICE_HISTORY) : next;
}

/**
 * 收集当前状态与历史栈共同引用的所有 Blob key。
 *
 * 撤销依赖历史栈里的 blob 仍然存在，所以编辑期间不能删单个 asset 的 blob。
 * 只在关闭工作区时用这个集合做一次回收。
 */
export function collectLiveBlobKeys(
  draft: SliceWorkspaceDraft,
  past: SliceHistoryEntry[],
  future: SliceHistoryEntry[],
): Set<string> {
  const keys = new Set<string>();
  const addAsset = (asset: SliceAsset) => {
    if (asset.originalBlobKey) keys.add(asset.originalBlobKey);
    if (asset.currentBlobKey) keys.add(asset.currentBlobKey);
    if (asset.transparentBlobKey) keys.add(asset.transparentBlobKey);
    if (asset.aiTransparentBlobKey) keys.add(asset.aiTransparentBlobKey);
    if (asset.repairBlobKey) keys.add(asset.repairBlobKey);
    for (const snapshot of Object.values(asset.processSnapshots ?? {})) {
      if (snapshot?.currentBlobKey) keys.add(snapshot.currentBlobKey);
    }
  };

  if (draft.sourceImageBlobKey) keys.add(draft.sourceImageBlobKey);
  if (draft.thumbnailBlobKey) keys.add(draft.thumbnailBlobKey);
  for (const asset of draft.assets || []) addAsset(asset);
  for (const entry of [...past, ...future]) {
    for (const asset of entry.assets || []) addAsset(asset);
  }
  return keys;
}

/**
 * 回收既不被当前状态、也不被历史栈引用的孤儿 Blob。
 *
 * 只能在历史栈即将被丢弃时调用（关闭工作区），否则会破坏撤销。
 * 候选集来自被丢弃的历史快照 —— 全库扫描代价太大且会误删其它工作区的 blob。
 */
async function gcOrphanBlobs(
  draft: SliceWorkspaceDraft,
  past: SliceHistoryEntry[],
  future: SliceHistoryEntry[],
): Promise<void> {
  // 存活集只看当前状态：历史栈马上就没了
  const live = collectLiveBlobKeys(draft, [], []);
  const candidates = new Set<string>();
  for (const entry of [...past, ...future]) {
    for (const asset of entry.assets || []) {
      for (const key of [
        asset.originalBlobKey,
        asset.currentBlobKey,
        asset.transparentBlobKey,
        asset.aiTransparentBlobKey,
        asset.repairBlobKey,
        ...Object.values(asset.processSnapshots ?? {}).map((snapshot) => snapshot?.currentBlobKey),
      ]) {
        if (key && !live.has(key)) candidates.add(key);
      }
    }
  }
  await Promise.all(Array.from(candidates).map((key) => deleteBlob(key)));
}

export const useSliceStore = create<SliceStore>()((set, get) => ({
  hydrated: false,
  workspaces: [],
  activeWorkspaceId: null,
  activeWorkspace: null,
  past: [],
  future: [],

  hydrate: async () => {
    const workspaces = await listWorkspaces();
    set({ workspaces, hydrated: true });
  },

  createWorkspace: async (sourceImageBlob, screen) => {
    const sourceImageBlobKey = await putBlob(sourceImageBlob, sourceImageBlob.type || 'image/png');
    const now = new Date().toISOString();
    const id = nanoid();
    const draft: SliceWorkspaceDraft = {
      id,
      note: '未命名切图',
      createdAt: now,
      updatedAt: now,
      screen,
      sourceImageBlobKey,
      thumbnailBlobKey: null,
      assets: [],
    };
    await saveWorkspace(draft);
    const workspaces = await listWorkspaces();
    set({ workspaces, activeWorkspaceId: id, activeWorkspace: draft, past: [], future: [] });
    return id;
  },

  openWorkspace: async (id) => {
    const draft = await getWorkspace(id);
    if (!draft) return;
    // 切换工作区清空历史：跨工作区撤销没有意义，也会让 blob 回收无法判定
    set({ activeWorkspaceId: id, activeWorkspace: draft, past: [], future: [] });
  },

  closeWorkspace: () => {
    const { activeWorkspace, past, future } = get();
    if (activeWorkspace) {
      flushSave(activeWorkspace);
      // 历史栈即将丢弃，此时回收其中引用而当前状态不再引用的孤儿 Blob
      void gcOrphanBlobs(activeWorkspace, past, future);
    }
    gestureActive = false;
    lastMerge = null;
    set({ activeWorkspaceId: null, activeWorkspace: null, past: [], future: [] });
  },

  updateWorkspaceNote: async (id, note) => {
    const draft = await getWorkspace(id);
    if (!draft) return;
    const next: SliceWorkspaceDraft = { ...draft, note, updatedAt: new Date().toISOString() };
    await saveWorkspace(next);
    const workspaces = await listWorkspaces();
    set((state) => ({
      workspaces,
      activeWorkspace: state.activeWorkspaceId === id ? next : state.activeWorkspace,
    }));
  },

  deleteWorkspace: async (id) => {
    await deleteWorkspaceDb(id);
    const workspaces = await listWorkspaces();
    set((state) => {
      if (state.activeWorkspaceId === id) {
        return { workspaces, activeWorkspaceId: null, activeWorkspace: null, past: [], future: [] };
      }
      return { workspaces };
    });
  },

  copyWorkspace: async (id) => {
    await copyWorkspaceDb(id);
    const workspaces = await listWorkspaces();
    set({ workspaces });
  },

  updateActiveWorkspace: async (updater) => {
    const current = get().activeWorkspace;
    if (!current) return;
    // 深拷贝当前 activeWorkspace，对副本执行 updater（就地修改）
    const next: SliceWorkspaceDraft = structuredClone(current);
    updater(next);
    next.updatedAt = new Date().toISOString();
    // 立即更新内存状态（含工作区列表中的对应条目），防抖持久化
    set((state) => ({
      activeWorkspace: next,
      workspaces: state.workspaces.map((w) => (w.id === next.id ? next : w)),
    }));
    scheduleSave(next);
  },

  applySilent: async (updater) => {
    await get().updateActiveWorkspace(updater);
  },

  commit: async (label, updater) => {
    const current = get().activeWorkspace;
    if (!current) return;
    const entry: SliceHistoryEntry = { assets: snapshotAssets(current), label };
    lastMerge = null;
    set((state) => ({ past: pushPast(state.past, entry), future: [] }));
    await get().updateActiveWorkspace(updater);
  },

  mergeCommit: async (mergeKey, label, updater) => {
    const current = get().activeWorkspace;
    if (!current) return;
    const now = Date.now();
    // elapsed >= 0 的守卫不是多余的：系统时钟回拨（或测试里切换 fake timers）会让 elapsed 变负，
    // 若只判断 < MERGE_WINDOW_MS，就会把两次本应独立的编辑错误地合并成一条历史。
    const elapsed = lastMerge === null ? Number.POSITIVE_INFINITY : now - lastMerge.at;
    const canMerge = lastMerge !== null && lastMerge.key === mergeKey && elapsed >= 0 && elapsed < MERGE_WINDOW_MS;

    if (canMerge) {
      // 复用栈顶那条历史：连续输入合并为一次撤销
      lastMerge = { key: mergeKey, at: now };
      set({ future: [] });
    } else {
      const entry: SliceHistoryEntry = { assets: snapshotAssets(current), label, mergeKey };
      lastMerge = { key: mergeKey, at: now };
      set((state) => ({ past: pushPast(state.past, entry), future: [] }));
    }
    await get().updateActiveWorkspace(updater);
  },

  beginGesture: (label) => {
    if (gestureActive) return;
    const current = get().activeWorkspace;
    if (!current) return;
    gestureActive = true;
    lastMerge = null;
    const entry: SliceHistoryEntry = { assets: snapshotAssets(current), label };
    set((state) => ({ past: pushPast(state.past, entry), future: [] }));
  },

  endGesture: () => {
    gestureActive = false;
  },

  undo: async () => {
    const { activeWorkspace, past } = get();
    if (!activeWorkspace || past.length === 0) return;
    const entry = past[past.length - 1];
    const redoEntry: SliceHistoryEntry = {
      assets: snapshotAssets(activeWorkspace),
      label: entry.label,
    };
    const next: SliceWorkspaceDraft = {
      ...structuredClone(activeWorkspace),
      assets: structuredClone(entry.assets),
      updatedAt: new Date().toISOString(),
    };
    lastMerge = null;
    set((state) => ({
      past: state.past.slice(0, -1),
      future: [...state.future, redoEntry],
      activeWorkspace: next,
      workspaces: state.workspaces.map((w) => (w.id === next.id ? next : w)),
    }));
    flushSave(next);
  },

  redo: async () => {
    const { activeWorkspace, future } = get();
    if (!activeWorkspace || future.length === 0) return;
    const entry = future[future.length - 1];
    const undoEntry: SliceHistoryEntry = {
      assets: snapshotAssets(activeWorkspace),
      label: entry.label,
    };
    const next: SliceWorkspaceDraft = {
      ...structuredClone(activeWorkspace),
      assets: structuredClone(entry.assets),
      updatedAt: new Date().toISOString(),
    };
    lastMerge = null;
    set((state) => ({
      future: state.future.slice(0, -1),
      past: pushPast(state.past, undoEntry),
      activeWorkspace: next,
      workspaces: state.workspaces.map((w) => (w.id === next.id ? next : w)),
    }));
    flushSave(next);
  },

  getActiveWorkspace: () => get().activeWorkspace,

  setReconstructedHtml: async (html) => {
    await get().updateActiveWorkspace((draft) => {
      draft.reconstructedHtml = html;
    });
  },

  // 网页复刻的三文件与 agent 对话都走 updateActiveWorkspace 直接落盘，
  // 不进 undo/redo：历史快照只克隆 assets（见 snapshotAssets），
  // 把网页改动推进历史栈只会产生一堆撤销后毫无变化的空条目。
  setReplicaFiles: async (files) => {
    await get().updateActiveWorkspace((draft) => {
      draft.replicaFiles = files;
      // 三文件成为唯一事实来源后，旧的单文件字段必须清掉，
      // 否则 resolveReplicaFiles 的回退分支会留着一份永远不再更新的陈旧 HTML。
      draft.reconstructedHtml = null;
    });
  },

  setWebAgentMessages: async (messages) => {
    await get().updateActiveWorkspace((draft) => {
      draft.webAgentMessages = messages;
    });
  },

  setWebAgentUsage: async (usage) => {
    await get().updateActiveWorkspace((draft) => {
      draft.webAgentContextTokens = usage ? usage.inputTokens : null;
      draft.webAgentLastUsage = usage;
    });
  },

  clearWebAgentConversation: async () => {
    await get().updateActiveWorkspace((draft) => {
      draft.webAgentMessages = [];
      draft.webAgentContextTokens = null;
      draft.webAgentLastUsage = null;
    });
  },
}));

/** 供组件订阅的派生选择器。 */
export const selectCanUndo = (s: SliceStore) => s.past.length > 0;
export const selectCanRedo = (s: SliceStore) => s.future.length > 0;
export const selectUndoLabel = (s: SliceStore) =>
  s.past.length > 0 ? s.past[s.past.length - 1].label : null;
export const selectRedoLabel = (s: SliceStore) =>
  s.future.length > 0 ? s.future[s.future.length - 1].label : null;
