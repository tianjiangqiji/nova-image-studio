import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "../lib/localforage-storage";
import { cleanupUnusedCanvasStorage } from "../lib/canvas-storage-gc";
import type { CanvasBackgroundMode } from "../lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";

export type CanvasProject = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNodeData[];
  connections: CanvasConnection[];
  backgroundMode: CanvasBackgroundMode;
  showImageInfo: boolean;
  viewport: ViewportTransform;
};

type CanvasProjectPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "backgroundMode" | "showImageInfo" | "viewport">>;
type CanvasProjectUpdateOptions = { touchUpdatedAt?: boolean };
export type CanvasSaveStatus = "saved" | "saving" | "error";

type CanvasStore = {
  hydrated: boolean;
  saveStatus: CanvasSaveStatus;
  projects: CanvasProject[];
  createProject: (title?: string) => string;
  importProject: (project: Partial<CanvasProject>) => string;
  openProject: (id: string) => CanvasProject | null;
  renameProject: (id: string, title: string) => void;
  deleteProjects: (ids: string[]) => void;
  replaceProjects: (projects: CanvasProject[]) => void;
  updateProject: (id: string, patch: CanvasProjectPatch, options?: CanvasProjectUpdateOptions) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "nova-image:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let queuedPersistValue: { name: string; value: StorageValue<CanvasStore> } | null = null;

async function persistQueuedCanvasState() {
  const queued = queuedPersistValue;
  if (!queued) return;
  queuedPersistValue = null;
  try {
    await localForageStorage.setItem(queued.name, JSON.stringify(queued.value));
    if (!queuedPersistValue) useCanvasStore.setState({ saveStatus: "saved" });
  } catch {
    useCanvasStore.setState({ saveStatus: "error" });
  }
}

export async function flushPendingCanvasSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persistQueuedCanvasState();
}

const canvasStorage: PersistStorage<CanvasStore> = {
  getItem: async (name) => {
    const value = await localForageStorage.getItem(name);
    if (!value) return null;
    const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
    queuedPersistState = parsed.state as PersistedCanvasState;
    return parsed;
  },
  setItem: (name, value) => {
    const nextState = value.state as PersistedCanvasState;
    if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
    queuedPersistState = nextState;
    queuedPersistValue = { name, value };
    useCanvasStore.setState({ saveStatus: "saving" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistQueuedCanvasState();
    }, 400);
  },
  removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set, get) => ({
      hydrated: false,
      saveStatus: "saved",
      projects: [],
      createProject: (title = "未命名画布") => {
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
          id,
          title,
          createdAt: now,
          updatedAt: now,
          nodes: [],
          connections: [],
          backgroundMode: "lines",
          showImageInfo: false,
          viewport: initialViewport,
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        return id;
      },
      importProject: (source) => {
        const now = new Date().toISOString();
        const project: CanvasProject = {
          id: nanoid(),
          title: source.title || "导入画布",
          createdAt: source.createdAt || now,
          updatedAt: now,
          nodes: source.nodes || [],
          connections: source.connections || [],
          backgroundMode: source.backgroundMode || "lines",
          showImageInfo: source.showImageInfo || false,
          viewport: source.viewport || initialViewport,
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        return project.id;
      },
      openProject: (id) => {
        return get().projects.find((item) => item.id === id) || null;
      },
      renameProject: (id, title) =>
        set((state) => ({
          projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
        })),
      deleteProjects: (ids) => {
        const projects = get().projects.filter((project) => !ids.includes(project.id));
        set({ projects });
        void cleanupUnusedCanvasStorage(projects);
      },
      replaceProjects: (projects) => set({ projects }),
      updateProject: (id, patch, options) =>
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== id) return project;
            const changed = Object.entries(patch).some(([key, value]) => project[key as keyof CanvasProject] !== value);
            if (!changed) return project;
            return {
              ...project,
              ...patch,
              updatedAt: options?.touchUpdatedAt === false ? project.updatedAt : new Date().toISOString(),
            };
          }),
        })),
    }),
    {
      name: CANVAS_STORE_KEY,
      storage: canvasStorage,
      partialize: (state) =>
        ({
          projects: state.projects,
        }) as StorageValue<CanvasStore>["state"],
      onRehydrateStorage: () => () => {
        useCanvasStore.setState({ hydrated: true });
      },
    },
  ),
);
