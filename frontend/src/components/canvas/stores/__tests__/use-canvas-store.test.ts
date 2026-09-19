import { beforeEach, describe, expect, it, vi } from "vitest";

const setItemMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cleanupUnusedMediaMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../lib/localforage-storage", () => ({
  localForageStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: setItemMock,
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../lib/canvas-storage-gc", () => ({ cleanupUnusedCanvasStorage: cleanupUnusedMediaMock }));

import { flushPendingCanvasSave, useCanvasStore, type CanvasProject } from "../use-canvas-store";
import { CanvasNodeType } from "../../types";

const project: CanvasProject = {
  id: "project",
  title: "Canvas",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  nodes: [],
  connections: [],
  backgroundMode: "lines",
  showImageInfo: false,
  viewport: { x: 0, y: 0, k: 1 },
};

describe("canvas store persistence semantics", () => {
  beforeEach(() => {
    setItemMock.mockClear();
    cleanupUnusedMediaMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:00.000Z"));
    useCanvasStore.setState({ hydrated: true, projects: [structuredClone(project)] });
    useCanvasStore.setState({ saveStatus: "saved" });
  });

  it("does not touch updatedAt for viewport-only changes", () => {
    useCanvasStore.getState().updateProject("project", { viewport: { x: 20, y: 30, k: 1.2 } }, { touchUpdatedAt: false });

    expect(useCanvasStore.getState().openProject("project")?.updatedAt).toBe(project.updatedAt);
  });

  it("touches updatedAt for content changes", () => {
    useCanvasStore.getState().updateProject("project", { nodes: [{ id: "n", title: "N", type: CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 100, height: 80 }] });

    expect(useCanvasStore.getState().openProject("project")?.updatedAt).toBe("2026-07-28T08:00:00.000Z");
  });

  it("flushes a queued save before leaving the canvas", async () => {
    useCanvasStore.getState().renameProject("project", "Renamed");

    expect(useCanvasStore.getState().saveStatus).toBe("saving");
    await flushPendingCanvasSave();

    expect(setItemMock).toHaveBeenCalled();
    expect(useCanvasStore.getState().saveStatus).toBe("saved");
  });

  it("cleans blobs using projects that remain after deletion", async () => {
    const remaining = { ...structuredClone(project), id: "remaining" };
    useCanvasStore.setState({ projects: [structuredClone(project), remaining] });

    useCanvasStore.getState().deleteProjects([project.id]);
    await Promise.resolve();

    expect(cleanupUnusedMediaMock).toHaveBeenCalledWith([remaining]);
  });
});
