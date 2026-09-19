import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasEditor } from "../CanvasEditor";
import { useCanvasStore, type CanvasProject } from "../stores/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";

const submitNodeGenerationMock = vi.hoisted(() => vi.fn());
const pollNodeTaskMock = vi.hoisted(() => vi.fn());
const checkExistingTaskMock = vi.hoisted(() => vi.fn());
const cleanupUnusedCanvasStorageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../lib/canvas-storage-gc", () => ({ cleanupUnusedCanvasStorage: cleanupUnusedCanvasStorageMock }));

vi.mock("../canvas-generation-service", async () => {
  const actual = await vi.importActual<typeof import("../canvas-generation-service")>("../canvas-generation-service");
  return {
    ...actual,
    submitNodeGeneration: submitNodeGenerationMock,
    pollNodeTask: pollNodeTaskMock,
    checkExistingTask: checkExistingTaskMock,
  };
});

function textNode(id: string, title: string): CanvasNodeData {
  return {
    id,
    title,
    type: CanvasNodeType.Text,
    position: { x: 40, y: 40 },
    width: 240,
    height: 160,
    metadata: { content: title },
  };
}

const project: CanvasProject = {
  id: "route-project",
  title: "Prompt routes",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  nodes: [
    textNode("core", "核心提示词"),
    textNode("concept", "城市创意"),
    textNode("beijing", "北京专属"),
    {
      id: "config-1",
      title: "北京生成配置1",
      type: CanvasNodeType.Config,
      position: { x: 800, y: 40 },
      width: 360,
      height: 280,
      metadata: { composerContent: "胶片海报质感" },
    },
  ],
  connections: [
    { id: "core-concept", fromNodeId: "core", toNodeId: "concept" },
    { id: "concept-beijing", fromNodeId: "concept", toNodeId: "beijing" },
    { id: "core-beijing", fromNodeId: "core", toNodeId: "beijing" },
    { id: "beijing-config-1", fromNodeId: "beijing", toNodeId: "config-1" },
  ],
  backgroundMode: "lines",
  showImageInfo: false,
  viewport: { x: 0, y: 0, k: 1 },
};

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe("CanvasEditor prompt routes", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    cleanupUnusedCanvasStorageMock.mockReset().mockResolvedValue(undefined);
    useCanvasStore.setState({ hydrated: true, projects: [structuredClone(project)] });
    submitNodeGenerationMock.mockReset();
    submitNodeGenerationMock.mockResolvedValue("task-1");
    pollNodeTaskMock.mockReset();
    pollNodeTaskMock.mockResolvedValue([]);
    checkExistingTaskMock.mockReset().mockResolvedValue({ status: "processing" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists complete routes and persists the selected route on the config", async () => {
    render(
      <CanvasEditor
        projectId={project.id}
        onBack={() => undefined}
        onRequireApiKey={() => undefined}
        showToast={() => undefined}
      />,
    );

    const select = screen.getByRole("combobox", { name: "提示词路线" });
    fireEvent.click(select);
    const option = await screen.findByRole("option", { name: "核心提示词 -> 城市创意 -> 北京专属" });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);

    await waitFor(() => {
      const config = useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "config-1");
      expect(config?.metadata?.promptRouteSelection).toEqual({
        mode: "route",
        connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"],
      });
    });
  });

  it("undoes a prompt route selection", async () => {
    render(
      <CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />,
    );
    const select = screen.getByRole("combobox", { name: "提示词路线" });
    fireEvent.click(select);
    const option = await screen.findByRole("option", { name: "核心提示词 -> 城市创意 -> 北京专属" });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "config-1")?.metadata?.promptRouteSelection?.mode).toBe("route");
    });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "config-1")?.metadata?.promptRouteSelection).toBeUndefined();
    });
  });

  it("undoes a burst of text input as one edit", async () => {
    const { container } = render(
      <CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />,
    );
    const coreNode = container.querySelector('[data-node-id="core"]')!;
    const textarea = within(coreNode as HTMLElement).getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "核心提示词 A" } });
    fireEvent.change(textarea, { target: { value: "核心提示词 AB" } });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "core")?.metadata?.content).toBe("核心提示词");
    });
  });

  it("renames a node inline and refreshes route labels", async () => {
    const seeded = structuredClone(project);
    const core = seeded.nodes.find((node) => node.id === "core")!;
    core.title = "文本";
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    const { container } = render(
      <CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />,
    );
    const coreNode = container.querySelector('[data-node-id="core"]')!;
    const getTitleHeader = () => within(coreNode as HTMLElement).getByTitle("双击重命名节点");

    fireEvent.doubleClick(getTitleHeader());
    const titleInput = within(coreNode as HTMLElement).getByRole("textbox", { name: "节点标题" });
    fireEvent.change(titleInput, { target: { value: "  核心提示词  " } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(getTitleHeader()).toHaveTextContent("核心提示词");
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "core")?.title).toBe("核心提示词");
    });

    const select = screen.getByRole("combobox", { name: "提示词路线" });
    fireEvent.click(select);
    expect(await screen.findByRole("option", { name: "核心提示词 -> 城市创意 -> 北京专属" })).toBeInTheDocument();
    fireEvent.keyDown(select, { key: "Escape" });

    fireEvent.doubleClick(getTitleHeader());
    const cancelledInput = within(coreNode as HTMLElement).getByRole("textbox", { name: "节点标题" });
    fireEvent.change(cancelledInput, { target: { value: "取消后的标题" } });
    fireEvent.keyDown(cancelledInput, { key: "Escape" });
    expect(getTitleHeader()).toHaveTextContent("核心提示词");

    fireEvent.doubleClick(getTitleHeader());
    const emptyInput = within(coreNode as HTMLElement).getByRole("textbox", { name: "节点标题" });
    fireEvent.change(emptyInput, { target: { value: "   " } });
    fireEvent.blur(emptyInput);
    expect(getTitleHeader()).toHaveTextContent("核心提示词");
  });

  it("saves an inline node rename when the blank canvas is pressed", async () => {
    const { container } = render(
      <CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />,
    );
    const coreNode = container.querySelector('[data-node-id="core"]')!;
    fireEvent.doubleClick(within(coreNode as HTMLElement).getByTitle("双击重命名节点"));
    const titleInput = within(coreNode as HTMLElement).getByRole("textbox", { name: "节点标题" });
    fireEvent.change(titleInput, { target: { value: "画布点击后保存" } });

    const canvas = container.querySelector('[data-canvas-mode="select"]') as HTMLElement & { setPointerCapture: (pointerId: number) => void };
    canvas.setPointerCapture = vi.fn();
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 1,
      clientX: 1200,
      clientY: 700,
    });

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "core")?.title).toBe("画布点击后保存");
    });
  });

  it("undoes an inline node rename as one edit", async () => {
    const { container } = render(
      <CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />,
    );
    const coreNode = container.querySelector('[data-node-id="core"]')!;
    fireEvent.doubleClick(within(coreNode as HTMLElement).getByTitle("双击重命名节点"));
    const titleInput = within(coreNode as HTMLElement).getByRole("textbox", { name: "节点标题" });
    fireEvent.change(titleInput, { target: { value: "新的核心标题" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "core")?.title).toBe("核心提示词");
    });
  });

  it("highlights the selected config route", () => {
    const seeded = structuredClone(project);
    const config = seeded.nodes.find((node) => node.id === "config-1")!;
    config.metadata = {
      ...config.metadata,
      promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"] },
    };
    seeded.nodes.push(textNode("alternate", "备用路线"));
    seeded.connections.push({ id: "alternate-config", fromNodeId: "alternate", toNodeId: "config-1" });
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    const { container } = render(
      <CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />,
    );
    fireEvent.pointerDown(container.querySelector('[data-node-id="config-1"]')!, { button: 0, clientX: 900, clientY: 100 });

    expect(container.querySelector('[data-node-id="core"]')).toHaveAttribute("data-route-active", "true");
    expect(container.querySelector('[data-node-id="concept"]')).toHaveAttribute("data-route-active", "true");
    expect(container.querySelector('[data-node-id="beijing"]')).toHaveAttribute("data-route-active", "true");
    expect(container.querySelector('[data-connection-id="core-concept"]')).toHaveAttribute("data-route-active", "true");
    expect(container.querySelector('[data-connection-id="core-beijing"]')).not.toHaveAttribute("data-route-active");
    const alternateHitPath = container.querySelector('[data-connection-id="alternate-config"]');
    expect(alternateHitPath?.nextElementSibling).toHaveAttribute("stroke", "var(--muted-foreground)");
  });

  it("keeps deleted node blobs available for undo cleanup", async () => {
    const seeded = structuredClone(project);
    seeded.nodes.push({
      id: "image-1",
      title: "图片",
      type: CanvasNodeType.Image,
      position: { x: 40, y: 260 },
      width: 240,
      height: 160,
      metadata: { storageKey: "image:undo", content: "blob:undo" },
    });
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });
    const { container } = render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);

    fireEvent.pointerDown(container.querySelector('[data-node-id="image-1"]')!, { button: 0, clientX: 80, clientY: 300 });
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(cleanupUnusedCanvasStorageMock).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ nodes: expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ storageKey: "image:undo" }) }),
      ]) }),
    ])));
  });

  it("marks a deleted selected route invalid and disables generation", () => {
    const seeded = structuredClone(project);
    seeded.connections = seeded.connections.filter((connection) => connection.id !== "core-concept");
    const config = seeded.nodes.find((node) => node.id === "config-1")!;
    config.metadata = {
      ...config.metadata,
      promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"] },
    };
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);

    expect(screen.getByRole("combobox", { name: "提示词路线" })).toHaveTextContent("所选路线已失效，请重新选择");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
  });

  it("generates from a selected route when the config supplement is empty", async () => {
    const seeded = structuredClone(project);
    const config = seeded.nodes.find((node) => node.id === "config-1")!;
    config.metadata = {
      ...config.metadata,
      composerContent: "",
      promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"] },
    };
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => {
      expect(submitNodeGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "核心提示词\n\n城市创意\n\n北京专属",
      }));
      const resultNode = useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.type === CanvasNodeType.Image);
      expect(resultNode?.title).toBe("北京生成配置1 - 结果 1");
    });
  });

  it("keeps a completed remote result visible while local caching is pending", async () => {
    const seeded = structuredClone(project);
    const config = seeded.nodes.find((node) => node.id === "config-1")!;
    config.metadata = {
      ...config.metadata,
      promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"] },
    };
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });
    pollNodeTaskMock.mockResolvedValue([{
      url: "/api/nova/images/task-1/0",
      remoteUrl: "/api/nova/images/task-1/0",
      width: 1024,
      height: 1024,
      mimeType: "image/png",
      bytes: 0,
      cacheStatus: "pending",
      cacheError: "HTTP 503",
    }]);

    render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => {
      const resultNode = useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.type === CanvasNodeType.Image);
      expect(resultNode?.metadata).toEqual(expect.objectContaining({
        content: "/api/nova/images/task-1/0",
        resultRemoteUrl: "/api/nova/images/task-1/0",
        resultCacheStatus: "pending",
        resultCacheError: "HTTP 503",
      }));
      expect(screen.getByRole("img", { name: "北京生成配置1 - 结果 1" })).toHaveAttribute("src", "/api/nova/images/task-1/0");
      expect(screen.getByRole("button", { name: "重新获取原图" })).toBeInTheDocument();
    });
  });

  it("resumes caching a pending result after the canvas is reopened", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetTimeout(handler, timeout === 15_000 ? 0 : timeout, ...args)) as typeof setTimeout);
    try {
      const seeded = structuredClone(project);
      seeded.nodes.push({
        id: "result-1",
        title: "北京结果",
        type: CanvasNodeType.Image,
        position: { x: 1200, y: 40 },
        width: 360,
        height: 360,
        metadata: {
          status: "success",
          content: "/api/nova/images/task-1/0",
          generationTaskId: "task-1",
          resultCacheStatus: "pending",
          resultRemoteUrl: "/api/nova/images/task-1/0",
        },
      });
      useCanvasStore.setState({ hydrated: true, projects: [seeded] });
      checkExistingTaskMock.mockResolvedValue({
        status: "completed",
        images: [{ storageKey: "image:1", url: "blob:image-1", width: 1024, height: 1024, mimeType: "image/png", bytes: 128, cacheStatus: "cached" }],
      });

      render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
      await waitFor(() => {
        const resultNode = useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "result-1");
        expect(checkExistingTaskMock).toHaveBeenCalledWith("task-1", 1);
        expect(resultNode?.metadata).toEqual(expect.objectContaining({ storageKey: "image:1", resultCacheStatus: "cached" }));
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("previews the final prompt before generation", async () => {
    const seeded = structuredClone(project);
    const config = seeded.nodes.find((node) => node.id === "config-1")!;
    config.metadata = {
      ...config.metadata,
      promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"] },
    };
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "预览最终提示词" }));

    const dialog = await screen.findByRole("dialog", { name: "生成预览" });
    expect(dialog.querySelector("pre")).toHaveTextContent("核心提示词");
    expect(dialog.querySelector("pre")).toHaveTextContent("城市创意");
    expect(dialog.querySelector("pre")).toHaveTextContent("北京专属");
    expect(dialog.querySelector("pre")).toHaveTextContent("胶片海报质感");
  });

  it("preflights and submits multiple selected config nodes", async () => {
    const seeded = structuredClone(project);
    seeded.nodes.push({
      id: "config-2",
      title: "北京生成配置2",
      type: CanvasNodeType.Config,
      position: { x: 800, y: 380 },
      width: 360,
      height: 280,
      metadata: { composerContent: "水墨海报质感" },
    });
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    const { container } = render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
    const config1 = container.querySelector<HTMLElement>('[data-node-id="config-1"]')!;
    const config2 = container.querySelector<HTMLElement>('[data-node-id="config-2"]')!;
    fireEvent.pointerDown(config1, { button: 0, clientX: 820, clientY: 80 });
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(config2, { button: 0, ctrlKey: true, clientX: 820, clientY: 420 });
    fireEvent.pointerUp(window);

    fireEvent.click(screen.getByRole("button", { name: "生成所选配置" }));
    const dialog = await screen.findByRole("dialog", { name: "批量生成" });
    expect(within(dialog).getByText(/^已选择/)).toHaveTextContent("2 个配置");
    fireEvent.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(submitNodeGenerationMock).toHaveBeenCalledTimes(2));
  });

  it("searches for a node and focuses it on the canvas", async () => {
    const { container } = render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "搜索节点" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "搜索节点" }), { target: { value: "北京生成" } });
    fireEvent.click(screen.getByRole("button", { name: "定位到 北京生成配置1" }));

    await waitFor(() => {
      const configNode = container.querySelector<HTMLElement>('[data-node-id="config-1"]')!;
      expect(configNode).toHaveAttribute("data-selected", "true");
    });
  });

  it("undoes a Markdown display-mode change", async () => {
    const { container } = render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
    const coreNode = container.querySelector<HTMLElement>('[data-node-id="core"]')!;

    fireEvent.contextMenu(coreNode, { clientX: 100, clientY: 100 });
    fireEvent.click(await screen.findByRole("button", { name: "切换 Markdown / 纯文本" }));
    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "core")?.metadata?.renderMode).toBe("markdown");
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.nodes.find((node) => node.id === "core")?.metadata?.renderMode).toBeUndefined();
    });
  });

  it("changes canvas display options from one settings menu", async () => {
    render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "画布显示设置" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "圆点背景" }));

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.backgroundMode).toBe("dots");
    });
  });

  it("rebuilds the selected route prompt when retrying a result node", async () => {
    const seeded = structuredClone(project);
    const config = seeded.nodes.find((node) => node.id === "config-1")!;
    config.metadata = {
      ...config.metadata,
      composerContent: "",
      promptRouteSelection: { mode: "route", connectionIds: ["core-concept", "concept-beijing", "beijing-config-1"] },
    };
    seeded.nodes.push({
      id: "result",
      title: "生成结果",
      type: CanvasNodeType.Image,
      position: { x: 1200, y: 40 },
      width: 360,
      height: 360,
      metadata: { status: "error", prompt: "旧提示词" },
    });
    seeded.connections.push({ id: "config-result", fromNodeId: "config-1", toNodeId: "result" });
    useCanvasStore.setState({ hydrated: true, projects: [seeded] });

    render(<CanvasEditor projectId={project.id} onBack={() => undefined} onRequireApiKey={() => undefined} showToast={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() => {
      expect(submitNodeGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "核心提示词\n\n城市创意\n\n北京专属",
      }));
    });
  });
});
