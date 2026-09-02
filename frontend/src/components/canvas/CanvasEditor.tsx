"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Check, CloudAlert, LoaderCircle } from "lucide-react";
import { nanoid } from "nanoid";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentAssetPickerDialog, AgentTextAssetPickerDialog } from "@/components/agent/AgentAssetPickerDialog";
import { addImageAsset, addTextAsset, getAssetBlob, type ImageAsset, type TextAsset } from "@/lib/asset-store";
import { InfiniteCanvas } from "./components/infinite-canvas";
import { CanvasNode, type ResizeCorner } from "./components/canvas-node";
import { ActiveConnectionPath, ConnectionPath } from "./components/canvas-connections";
import { Minimap } from "./components/canvas-mini-map";
import { CanvasZoomControls } from "./components/canvas-zoom-controls";
import { CanvasToolbar } from "./components/canvas-toolbar";
import { CanvasPromptGalleryImportDialog } from "./components/canvas-prompt-gallery-import-dialog";
import { CanvasTemplateDialog, type CanvasTemplate } from "./components/canvas-template-dialog";
import { CanvasContextMenu } from "./components/canvas-context-menu";
import { CanvasConfigNodePanel } from "./components/canvas-config-node-panel";
import { CanvasBatchGenerationDialog, CanvasGenerationPreviewDialog, type CanvasBatchPreviewItem } from "./components/canvas-generation-preview-dialog";
import { CanvasNodeSearchDialog } from "./components/canvas-node-search-dialog";
import { FullscreenImageViewer } from "./components/fullscreen-image-viewer";
import type { ImageActionPayload } from "@/lib/image-actions";
import { CanvasCropDialog, CanvasUpscaleDialog, CanvasSplitDialog, CanvasAngleDialog } from "./components/canvas-node-dialogs";
import { canvasTheme } from "./lib/canvas-theme";
import { getNodeSpec } from "./constants";
import { flushPendingCanvasSave, useCanvasStore } from "./stores/use-canvas-store";
import { useCanvasConfigStore } from "./stores/use-canvas-config-store";
import { CanvasApiKeyMissingError, submitNodeGeneration, pollNodeTask, checkExistingTask, type CanvasGeneratedImage } from "./canvas-generation-service";
import {
  submitCanvasVideoGeneration,
  pollCanvasVideoTask,
  checkExistingVideoTask,
  visibleCanvasMediaFields,
  findCanvasPromptField,
  type CanvasVideoMediaItem,
} from "./canvas-video-generation-service";
import { clearPendingMedia, getPendingMedia } from "./lib/canvas-video-media-store";
import { clearUploadProgress } from "./lib/canvas-video-upload-store";
import { computeCanvasVideoBlockReason, effectiveVideoState, type CanvasImageOption } from "./components/canvas-video-config-section";
import {
  getPluginRegistryServerSnapshot,
  getPluginRegistrySnapshot,
  loadPluginRegistry,
  subscribePluginRegistry,
} from "@/lib/plugin-registry-client";
import type { FacetValues, FieldValues, InstalledPlugin } from "@/lib/plugin-schema";
import { buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext } from "./components/canvas-node-generation";
import { buildNodeMentionReferences } from "./utils/canvas-resource-references";
import { fitNodeSize } from "./utils/canvas-node-size";
import { getImageBlob, imageToDataUrl, resolveImageUrl, uploadImage, type UploadedImage } from "./lib/image-storage";
import { imageReferenceLabel } from "./lib/image-reference-prompt";
import {
  enumeratePromptRoutes,
  findSelectedPromptRoute,
  isInvalidPromptRouteSelection,
  MANUAL_PROMPT_ROUTE_VALUE,
} from "./lib/canvas-prompt-routes";
import { compressReferenceDataUrl, readFileAsDataUrl } from "./lib/image-utils";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationConfig, type CanvasInteractionMode, type CanvasNodeData, type CanvasNodeMetadata, type ContextMenuState, type ConnectionHandle, type Position, type SelectionBox, type ViewportTransform } from "./types";
import type { ReferenceImage } from "./types-media";
import { PromptOptimizeDialog } from "@/components/PromptOptimizeDialog";
import { AiTextGenerateDialog } from "./components/canvas-ai-text-dialog";
import { streamPromptOptimize, type StreamPromptOptimizeHandle, type OptimizeImageInput } from "@/lib/prompt-optimize-client";
import { requireDefaultConfiguredTextModel } from "@/lib/model-endpoints";
import { buildSimpleProxyTextRequestBody, handleSimpleTextStreamEvent } from "@/lib/nova-proxy-text";
import { readSseStream } from "@/lib/sse-stream-parser";
import { MODEL_IMAGE_LIMITS } from "@/lib/gemini-config";
import { normalizeModel } from "@/lib/model-capabilities";
import type { PromptWithKey } from "@/lib/prompt-gallery-data";
import { duplicateCanvasSelection } from "./utils/canvas-clipboard";
import { arrangeCanvasNodes, layoutCanvasGraph, type CanvasArrangeMode } from "./utils/canvas-layout";

type DialogState = { type: "crop" | "split" | "upscale" | "angle"; nodeId: string; source: string } | null;

type HistorySnapshot = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };

type CanvasEditorProps = {
  projectId: string;
  onBack: () => void;
  onRequireApiKey: () => void;
  showToast: (message: string, type: "success" | "error" | "info") => void;
  showPromptGallery?: boolean;
};

const MAX_HISTORY = 50;
const RESULT_CACHE_RETRY_DELAYS = [15_000, 30_000, 60_000] as const;

function waitForResultCacheRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function connectedNodeIds(seedId: string, connections: CanvasConnection[]) {
  const visited = new Set([seedId]);
  const queue = [seedId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const connection of connections) {
      const next = connection.fromNodeId === id ? connection.toNodeId : connection.toNodeId === id ? connection.fromNodeId : null;
      if (next && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return [...visited];
}

/**
 * 构建AI文本生成的系统提示词
 * 包含使用场景说明、用户意图识别和节点内容上下文
 */
function buildAiTextSystemPrompt(existingContent?: string): string {
  const sections: string[] = [];

  // 1. 使用场景说明
  sections.push(
    "你是一个AI文本生成助手，正在为无限画布（Infinite Canvas）中的文本节点生成内容。",
    "",
    "【使用场景】",
    "- 无限画布是一个可视化编排工具，用户可以在画布上创建文本节点来记录想法、提示词、说明等",
    "- 文本节点可以独立存在，也可以与其他节点（图片、配置节点等）建立连接关系",
    "- 用户可能想要新建内容，也可能是基于现有内容进行优化、扩展或改写",
    ""
  );

  // 2. 用户意图识别指导
  sections.push(
    "【用户意图识别】",
    "- 请仔细分析用户的输入，识别其核心意图：",
    "  1) 新建内容：用户希望从零开始创建特定类型的文本",
    "  2) 优化改进：用户希望基于现有内容进行润色、优化、精简或扩展",
    "  3) 格式转换：用户希望将内容转换为特定格式（如列表、标题、说明等）",
    "  4) 风格调整：用户希望改变文本的风格或语调",
    "  5) 信息补充：用户希望为现有内容添加更多信息或细节",
    "  6) 摘要概括：用户希望对长文本进行总结或提炼要点",
    "- 根据识别的意图，采用合适的生成策略和输出形式"
  );

  // 3. 节点内容上下文
  if (existingContent && existingContent.trim()) {
    sections.push(
      "",
      "【节点现有内容】",
      "当前文本节点已包含以下内容，请作为上下文参考：",
      "---",
      existingContent,
      "---",
      "",
      "注意事项：",
      "- 理解现有内容的主题、风格和结构",
      "- 如果用户要求修改或扩展，请保持与现有内容的一致性",
      "- 如果用户要求重新生成，可以基于现有内容提供全新的视角"
    );
  } else {
    sections.push(
      "",
      "【节点现有内容】",
      "当前文本节点为空，请根据用户需求创建全新的内容。"
    );
  }

  // 4. 输出要求
  sections.push(
    "",
    "【输出要求】",
    "- 直接输出最终文本，不要添加任何解释、前缀或额外说明",
    "- 保持内容简洁、清晰、有逻辑性",
    "- 如果是列表，使用标准的项目符号格式",
    "- 如果包含多段落，段落之间用空行分隔",
    "- 根据内容类型，合理使用标题、加粗等格式（如果支持）",
    "- 输出长度应根据用户需求和内容合理控制，不要冗长也不要过于简略"
  );

  return sections.join("\n");
}

function formatImageLabels(count: number) {
  const labels = Array.from({ length: count }, (_, index) => imageReferenceLabel(index));
  if (labels.length <= 1) return labels[0] || "模板参考图";
  return `${labels.slice(0, -1).join("、")}和${labels[labels.length - 1]}`;
}

function buildPromptGalleryCanvasPrompt(referenceImageCount: number) {
  const referenceLabels = formatImageLabels(referenceImageCount);
  const targetLabel = imageReferenceLabel(referenceImageCount);
  if (referenceImageCount <= 0) {
    return [
      `任务：以${targetLabel}中的角色/OC作为唯一身份来源，结合参考提示词生成画面。`,
      `目标角色图：${targetLabel}。优先保留该角色的脸型、五官、发型、发色、体型、服装、配饰、标志性特征和整体身份辨识度。`,
      "不要凭空替换角色身份，不要混合其他人物特征。",
    ].join("\n");
  }
  return [
    `任务：以${targetLabel}中的角色/OC作为唯一身份来源，将其角色特征覆盖到${referenceLabels}的模板画面中。`,
    `模板参考图：${referenceLabels}。只参考姿势、手势、口型、构图、镜头、背景、光影、材质、风格和行为。`,
    `目标角色图：${targetLabel}。优先保留该角色的脸型、五官、发型、发色、体型、服装、配饰、标志性特征和整体身份辨识度。`,
    "不要把模板参考图中的人物身份、脸、发型、服装或配饰当作最终角色来源，不要混合多个参考图的人物特征；除角色身份替换外，模板参考图的画面结构尽量保持不变。",
  ].join("\n");
}

function storedToMetadata(stored: UploadedImage | CanvasGeneratedImage, extra?: Partial<CanvasNodeMetadata>): CanvasNodeMetadata {
  const generated = "cacheStatus" in stored ? stored : undefined;
  return {
    status: "success",
    content: stored.url,
    storageKey: stored.storageKey,
    mimeType: stored.mimeType,
    naturalWidth: stored.width,
    naturalHeight: stored.height,
    bytes: stored.bytes,
    resultCacheStatus: generated?.cacheStatus,
    resultRemoteUrl: generated?.remoteUrl,
    resultCacheError: generated?.cacheError,
    ...extra,
  };
}

async function importPromptGalleryImage(url: string, promptContent: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const stored = await uploadImage(blob);
    return {
      downloaded: true,
      metadata: storedToMetadata(stored, { prompt: promptContent, canvasRole: "reference" }),
      width: stored.width,
      height: stored.height,
    };
  } catch {
    return {
      downloaded: false,
      metadata: { status: "success" as const, content: url, prompt: promptContent, canvasRole: "reference" as const },
      width: 320,
      height: 240,
    };
  }
}

async function optimizeImportedPromptContent(prompt: PromptWithKey, referenceImageCount: number): Promise<{ content: string; optimized: boolean }> {
  const original = prompt.content.trim();
  const textModel = requireDefaultConfiguredTextModel("promptOptimize");
  if (!original) return { content: original, optimized: false };

  let output = "";
  let failed = false;
  const handle = streamPromptOptimize(
    {
      apiKey: textModel.apiKey,
      model: textModel.id,
      mode: "canvas-prompt-gallery-import",
      prompt: original,
      context: `当前模板包含 ${referenceImageCount} 张参考图。画布会在生成配置里单独放置模板参考图，并用“目标角色图”单独指定用户上传的目标角色/OC图。`,
    },
    {
      onDelta(token) { output += token; },
      onDone(fullText) { if (fullText.trim()) output = fullText; },
      onError() { failed = true; },
    },
    textModel.baseUrl,
  );
  await handle.promise;

  const content = output.trim();
  return failed || !content ? { content: original, optimized: false } : { content, optimized: true };
}

export function CanvasEditor({ projectId, onBack, onRequireApiKey, showToast, showPromptGallery = true }: CanvasEditorProps) {
  const theme = canvasTheme;
  const openProject = useCanvasStore((state) => state.openProject);
  const updateProject = useCanvasStore((state) => state.updateProject);
  const saveStatus = useCanvasStore((state) => state.saveStatus);
  const renameProject = useCanvasStore((state) => state.renameProject);
  const projectTitle = useCanvasStore((state) => state.projects.find((item) => item.id === projectId)?.title) ?? "画布";
  const defaultConfig = useCanvasConfigStore((state) => state.config);
  const setStoreConfig = useCanvasConfigStore((state) => state.setConfig);

  const project = useMemo(() => openProject(projectId), [openProject, projectId]);

  const [nodes, setNodes] = useState<CanvasNodeData[]>(() => project?.nodes ?? []);
  const [connections, setConnections] = useState<CanvasConnection[]>(() => project?.connections ?? []);
  const [viewport, setViewport] = useState<ViewportTransform>(() => project?.viewport ?? { x: 0, y: 0, k: 1 });
  const [backgroundMode, setBackgroundMode] = useState(project?.backgroundMode ?? "lines");
  const [showImageInfo, setShowImageInfo] = useState(project?.showImageInfo ?? false);
  const [interactionMode, setInteractionMode] = useState<CanvasInteractionMode>("select");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [connecting, setConnecting] = useState<{ handle: ConnectionHandle; mouseWorld: Position; targetId?: string } | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [busyNodeIds, setBusyNodeIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [assetPicker, setAssetPicker] = useState<{ open: boolean; nodeId: string | null }>({ open: false, nodeId: null });
  const [textAssetPicker, setTextAssetPicker] = useState<{ open: boolean; nodeId: string | null }>({ open: false, nodeId: null });
  const [promptGalleryOpen, setPromptGalleryOpen] = useState(false);
  const [aiTextDialogOpen, setAiTextDialogOpen] = useState(false);
  const [aiTextGenerating, setAiTextGenerating] = useState(false);
  const [aiTextError, setAiTextError] = useState<string | null>(null);
  const [aiTextOriginal, setAiTextOriginal] = useState("");
  const [aiTextGenerated, setAiTextGenerated] = useState("");
  const [aiTextTargetNodeId, setAiTextTargetNodeId] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [promptGalleryImporting, setPromptGalleryImporting] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [replaceConfirm, setReplaceConfirm] = useState<{ nodeId: string; stored: UploadedImage } | null>(null);
  const [textReplaceConfirm, setTextReplaceConfirm] = useState<{ nodeId: string; content: string } | null>(null);
  const [fullscreenImageUrl, setFullscreenImageUrl] = useState<{ src: string; title: string; actionPayload?: ImageActionPayload } | null>(null);
  const [generationPreviewNodeId, setGenerationPreviewNodeId] = useState<string | null>(null);
  const [batchGenerationOpen, setBatchGenerationOpen] = useState(false);
  const [nodeSearchOpen, setNodeSearchOpen] = useState(false);
  const [nodeZIndexMap, setNodeZIndexMap] = useState<Record<string, number>>({});
  const topZIndexRef = useRef(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const interaction = useRef<
    | { kind: "drag"; startX: number; startY: number; origin: Map<string, Position> }
    | { kind: "connect"; handle: ConnectionHandle }
    | { kind: "selection"; additive: boolean; initial: string[] }
    | { kind: "resize"; nodeId: string; corner: ResizeCorner; startX: number; startY: number; width: number; height: number; pos: Position }
    | null
  >(null);
  const gestureActive = useRef(false);
  const clipboard = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[] }>({ nodes: [], connections: [] });
  const activeGenerationsRef = useRef<Map<string, AbortController>>(new Map());
  const resultCacheRetriesRef = useRef<Map<string, AbortController>>(new Map());
  const retryCooldownRef = useRef<Map<string, number>>(new Map());
  const textGenerationControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([]);
  const continuousHistoryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 提示词优化（结合连接的上游图片/文字引用）
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeNodeId, setOptimizeNodeId] = useState<string | null>(null);
  const [optimizeOriginalPrompt, setOptimizeOriginalPrompt] = useState("");
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

  // ---- persistence: content changes affect updatedAt; view-only changes do not ----
  useEffect(() => {
    if (!project) return;
    updateProject(projectId, { nodes, connections });
  }, [nodes, connections, project, projectId, updateProject]);

  useEffect(() => {
    if (!project) return;
    updateProject(projectId, { viewport, backgroundMode, showImageInfo }, { touchUpdatedAt: false });
  }, [viewport, backgroundMode, showImageInfo, project, projectId, updateProject]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushPendingCanvasSave();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => document.removeEventListener("visibilitychange", flushWhenHidden);
  }, []);

  // ---- resolve image blob URLs for nodes that only have a storageKey ----
  useEffect(() => {
    let cancelled = false;
    const missing = nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.storageKey && !imageUrls[node.metadata.storageKey]);
    if (!missing.length) return;
    void Promise.all(
      missing.map(async (node) => {
        const key = node.metadata!.storageKey!;
        // 持久化的 blob: URL 刷新后已失效，不能作为兜底（否则写回后仍 404）；优先从 IndexedDB 重建
        const content = node.metadata?.content;
        const fallback = content && !content.startsWith("blob:") ? content : "";
        const url = await resolveImageUrl(key, fallback);
        return [key, url] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setImageUrls((prev) => {
        const next = { ...prev };
        for (const [key, url] of entries) if (url) next[key] = url;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [nodes, imageUrls]);

  // ---- viewport size tracking ----
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const nodeImageUrl = useCallback(
    (node: CanvasNodeData) => {
      const key = node.metadata?.storageKey;
      if (key && imageUrls[key]) return imageUrls[key];
      const content = node.metadata?.content;
      // 刷新后失效的 blob: URL 不渲染，等待 storageKey 异步解析重建，避免 ERR_FILE_NOT_FOUND
      if (content && content.startsWith("blob:")) return undefined;
      return content;
    },
    [imageUrls],
  );

  // ---- 视频模式：插件注册表（视频生成完全由已安装的视频插件驱动） ----
  const pluginRegistry = useSyncExternalStore(subscribePluginRegistry, getPluginRegistrySnapshot, getPluginRegistryServerSnapshot);
  useEffect(() => {
    void loadPluginRegistry();
  }, []);
  const videoPlugins = useMemo(() => pluginRegistry.plugins.filter((plugin) => plugin.kind === "video"), [pluginRegistry.plugins]);

  // 画布上可作为帧引用/参考素材的图片节点（blob: 预览刷新后失效，参照 nodeImageUrl 只下发可靠地址）
  const canvasImages = useMemo<CanvasImageOption[]>(
    () =>
      nodes
        .filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey))
        .map((node) => {
          const key = node.metadata?.storageKey;
          const content = node.metadata?.content ?? "";
          const resolved = key ? imageUrls[key] : undefined;
          return { id: node.id, title: node.title, previewUrl: resolved ?? (content && !content.startsWith("blob:") ? content : undefined) };
        }),
    [imageUrls, nodes],
  );

  const createVideoNode = useCallback((position: Position, partial?: Partial<CanvasNodeData>): CanvasNodeData => {
    const spec = getNodeSpec(CanvasNodeType.Video);
    return { id: nanoid(), type: CanvasNodeType.Video, title: spec.title, position, width: spec.width, height: spec.height, metadata: { status: "idle" }, ...partial };
  }, []);

  // ---- history helpers ----
  const snapshot = useCallback((): HistorySnapshot => ({ nodes: nodes.map((node) => ({ ...node, metadata: { ...node.metadata } })), connections: connections.map((connection) => ({ ...connection })) }), [nodes, connections]);
  const pushHistory = useCallback(() => {
    setUndoStack((stack) => {
      const next = [...stack, snapshot()];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setRedoStack([]);
  }, [snapshot]);
  const clearContinuousHistory = useCallback(() => {
    continuousHistoryTimersRef.current.forEach((timer) => clearTimeout(timer));
    continuousHistoryTimersRef.current.clear();
  }, []);
  const recordContinuousHistory = useCallback((key: string) => {
    const currentTimer = continuousHistoryTimersRef.current.get(key);
    if (!currentTimer) pushHistory();
    else clearTimeout(currentTimer);
    continuousHistoryTimersRef.current.set(key, setTimeout(() => continuousHistoryTimersRef.current.delete(key), 600));
  }, [pushHistory]);
  useEffect(() => clearContinuousHistory, [clearContinuousHistory]);
  const beginGesture = useCallback(() => {
    if (gestureActive.current) return;
    gestureActive.current = true;
    pushHistory();
  }, [pushHistory]);
  const undo = useCallback(() => {
    if (!undoStack.length) return;
    clearContinuousHistory();
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((redo) => [...redo, snapshot()]);
    setUndoStack((stack) => stack.slice(0, -1));
    setNodes(previous.nodes);
    setConnections(previous.connections);
  }, [clearContinuousHistory, snapshot, undoStack]);
  const redo = useCallback(() => {
    if (!redoStack.length) return;
    clearContinuousHistory();
    const next = redoStack[redoStack.length - 1];
    setUndoStack((stack) => [...stack, snapshot()]);
    setRedoStack((redo) => redo.slice(0, -1));
    setNodes(next.nodes);
    setConnections(next.connections);
  }, [clearContinuousHistory, snapshot, redoStack]);

  const worldFromClient = useCallback(
    (clientX: number, clientY: number): Position => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - viewport.x) / viewport.k, y: (clientY - rect.top - viewport.y) / viewport.k };
    },
    [viewport],
  );

  const viewportCenterWorld = useCallback((): Position => {
    return { x: (viewportSize.width / 2 - viewport.x) / viewport.k, y: (viewportSize.height / 2 - viewport.y) / viewport.k };
  }, [viewport, viewportSize]);

  // ---- node mutations ----
  const patchNode = useCallback((nodeId: string, patch: (node: CanvasNodeData) => CanvasNodeData) => {
    setNodes((prev) => prev.map((node) => (node.id === nodeId ? patch(node) : node)));
  }, []);

  const createImageNode = useCallback((position: Position, partial?: Partial<CanvasNodeData>): CanvasNodeData => {
    const spec = getNodeSpec(CanvasNodeType.Image);
    return { id: nanoid(), type: CanvasNodeType.Image, title: spec.title, position, width: spec.width, height: spec.height, metadata: { status: "idle" }, ...partial };
  }, []);

  const createTextNode = useCallback((position: Position, content: string): CanvasNodeData => {
    const spec = getNodeSpec(CanvasNodeType.Text);
    return {
      id: nanoid(),
      type: CanvasNodeType.Text,
      title: spec.title,
      position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
      width: spec.width,
      height: spec.height,
      metadata: { ...spec.metadata, content },
    };
  }, []);

  const addNode = useCallback(
    (type: CanvasNodeType, position?: Position) => {
      pushHistory();
      const spec = getNodeSpec(type);
      const center = position ?? viewportCenterWorld();
      const metadata: CanvasNodeMetadata = { ...spec.metadata };
      if (type === CanvasNodeType.Config) metadata.genConfig = defaultConfig;
      const node: CanvasNodeData = {
        id: nanoid(),
        type,
        title: spec.title,
        position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
        width: spec.width,
        height: spec.height,
        metadata,
      };
      setNodes((prev) => [...prev, node]);
      setSelectedConnectionId(null);
      setSelectedIds([node.id]);
    },
    [defaultConfig, pushHistory, viewportCenterWorld],
  );

  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      pushHistory();
      const idSet = new Set(ids);
      // 被删节点上的进行中任务直接中止；模块级 store 的条目不随节点移除，需显式清理
      for (const id of ids) {
        if (activeGenerationsRef.current.has(id)) {
          activeGenerationsRef.current.get(id)?.abort();
          activeGenerationsRef.current.delete(id);
        }
        clearUploadProgress(id);
        if (nodes.find((node) => node.id === id)?.type === CanvasNodeType.Config) clearPendingMedia(id);
      }
      setNodes((prev) =>
        prev
          .filter((node) => !idSet.has(node.id))
          .map((node) => {
            // 剩余编排节点上指向被删图片节点的帧引用是死引用，一并清除（保留其余字段）
            if (node.type !== CanvasNodeType.Config) return node;
            const frameRefs = node.metadata?.videoFrameRefs;
            if (!frameRefs || !Object.values(frameRefs).some((refId) => refId && idSet.has(refId))) return node;
            const nextRefs = { ...frameRefs };
            for (const [slot, refId] of Object.entries(nextRefs)) {
              if (refId && idSet.has(refId)) delete nextRefs[slot];
            }
            return { ...node, metadata: { ...node.metadata, videoFrameRefs: nextRefs } };
          }),
      );
      setConnections((prev) => prev.filter((connection) => !idSet.has(connection.fromNodeId) && !idSet.has(connection.toNodeId)));
      setSelectedConnectionId(null);
      setSelectedIds((prev) => prev.filter((id) => !idSet.has(id)));
    },
    [nodes, pushHistory],
  );

  const pasteClipboardAt = useCallback((position: Position) => {
    if (!clipboard.current.nodes.length) return;
    const duplicated = duplicateCanvasSelection(clipboard.current.nodes, clipboard.current.connections, clipboard.current.nodes.map((node) => node.id), nanoid, 0);
    const minX = Math.min(...duplicated.nodes.map((node) => node.position.x));
    const minY = Math.min(...duplicated.nodes.map((node) => node.position.y));
    const placedNodes = duplicated.nodes.map((node) => ({ ...node, position: { x: node.position.x - minX + position.x, y: node.position.y - minY + position.y } }));
    pushHistory();
    setNodes((current) => [...current, ...placedNodes]);
    setConnections((current) => [...current, ...duplicated.connections]);
    setSelectedIds(placedNodes.map((node) => node.id));
    setSelectedConnectionId(null);
  }, [pushHistory]);

  const deleteConnection = useCallback(
    (connectionId: string | null) => {
      if (!connectionId) return;
      pushHistory();
      setConnections((prev) => prev.filter((connection) => connection.id !== connectionId));
      setSelectedConnectionId((selectedId) => (selectedId === connectionId ? null : selectedId));
    },
    [pushHistory],
  );

  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const duplicated = duplicateCanvasSelection(nodes, connections, ids, nanoid, 32);
      if (!duplicated.nodes.length) return;
      pushHistory();
      setNodes((prev) => [...prev, ...duplicated.nodes]);
      setConnections((prev) => [...prev, ...duplicated.connections]);
      setSelectedConnectionId(null);
      setSelectedIds(duplicated.nodes.map((node) => node.id));
    },
    [connections, nodes, pushHistory],
  );

  // ---- image source: upload / asset library / save to assets ----
  const fillNodeWithStored = useCallback(
    (nodeId: string, stored: UploadedImage) => {
      pushHistory();
      const size = fitNodeSize(stored.width, stored.height, 360, 360);
      patchNode(nodeId, (node) => ({ ...node, width: size.width, height: size.height, metadata: { ...node.metadata, ...storedToMetadata(stored) } }));
    },
    [patchNode, pushHistory],
  );

  // 填充前若已有图片，先弹「是否替换」确认。
  const fillNodeWithConfirm = useCallback(
    (nodeId: string, stored: UploadedImage) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (node?.metadata?.content) {
        setReplaceConfirm({ nodeId, stored });
        return;
      }
      fillNodeWithStored(nodeId, stored);
    },
    [fillNodeWithStored, nodes],
  );

  // 仅删除节点内图片（保留节点，回到空态）。
  const clearNodeImage = useCallback(
    (nodeId: string) => {
      pushHistory();
      patchNode(nodeId, (node) => ({ ...node, metadata: { status: "idle", ...(node.metadata?.canvasRole === "target" ? { canvasRole: "target" as const } : {}) } }));
    },
    [patchNode, pushHistory],
  );

  const ingestFiles = useCallback(
    async (files: FileList | File[], position?: Position) => {
      const list = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (!list.length) return;
      pushHistory();
      const base = position ?? viewportCenterWorld();
      let offset = 0;
      for (const file of list) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const stored = await uploadImage(dataUrl);
          const size = fitNodeSize(stored.width, stored.height, 320, 320);
          const node = createImageNode({ x: base.x + offset, y: base.y + offset }, { metadata: storedToMetadata(stored), width: size.width, height: size.height });
          setNodes((prev) => [...prev, node]);
          offset += 28;
        } catch {
          showToast("图片读取失败", "error");
        }
      }
    },
    [createImageNode, pushHistory, showToast, viewportCenterWorld],
  );

  const handleNodeUpload = useCallback((nodeId: string) => {
    uploadTargetRef.current = nodeId;
    fileInputRef.current?.click();
  }, []);

  const handleNodeImport = useCallback((nodeId: string) => {
    setAssetPicker({ open: true, nodeId });
  }, []);

  const handleTextNodeImport = useCallback((nodeId: string) => {
    setTextAssetPicker({ open: true, nodeId });
  }, []);

  const handleAssetPickerConfirm = useCallback(
    async (assets: ImageAsset[]) => {
      const targetId = assetPicker.nodeId;
      const asset = assets[0];
      if (!asset || !targetId) return;
      try {
        const blob = await getAssetBlob(asset.id);
        if (!blob) {
          showToast("素材读取失败", "error");
          return;
        }
        const stored = await uploadImage(blob);
        fillNodeWithConfirm(targetId, stored);
      } catch {
        showToast("从素材库导入失败", "error");
      }
    },
    [assetPicker.nodeId, fillNodeWithConfirm, showToast],
  );

  const fillTextNode = useCallback(
    (nodeId: string, content: string) => {
      pushHistory();
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, content } }));
    },
    [patchNode, pushHistory],
  );

  const fillTextNodeWithConfirm = useCallback(
    (nodeId: string, content: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      const current = (node?.metadata?.content || "").trim();
      if (current && current !== content.trim()) {
        setTextReplaceConfirm({ nodeId, content });
        return;
      }
      fillTextNode(nodeId, content);
    },
    [fillTextNode, nodes],
  );

  const handleTextAssetPickerConfirm = useCallback(
    (asset: TextAsset) => {
      const targetId = textAssetPicker.nodeId;
      if (!targetId) return;
      fillTextNodeWithConfirm(targetId, asset.content);
    },
    [fillTextNodeWithConfirm, textAssetPicker.nodeId],
  );

  const handleSaveTextToAssets = useCallback(
    async (node: CanvasNodeData) => {
      const content = (node.metadata?.content || "").trim();
      if (!content) return;
      try {
        await addTextAsset({
          content,
          sourceKind: 'manual',
          sourceLabel: '无限画布',
          sourceRef: node.id,
        });
        showToast("提示词素材已保存", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "保存提示词素材失败", "error");
      }
    },
    [showToast],
  );

  const importPromptGalleryTemplate = useCallback(
    async (prompt: PromptWithKey) => {
      if (promptGalleryImporting) return;
      setPromptGalleryImporting(true);
      try {
        const imageUrls = prompt.images.filter(Boolean);
        const optimizedPrompt = await optimizeImportedPromptContent(prompt, imageUrls.length);
        const promptContent = optimizedPrompt.content || prompt.content;
        const importedImages = await Promise.all(imageUrls.map((url) => importPromptGalleryImage(url, promptContent)));
        const failedCount = importedImages.filter((image) => !image.downloaded).length;
        const center = viewportCenterWorld();
        const cols = imageUrls.length > 4 ? 3 : 2;
        const cellWidth = 280;
        const cellHeight = 260;
        const baseX = center.x - (cols * cellWidth + 540) / 2;
        const baseY = center.y - 220;
        const positionForInput = (index: number): Position => ({
          x: baseX + (index % cols) * cellWidth,
          y: baseY + Math.floor(index / cols) * cellHeight,
        });

        const referenceNodes = importedImages.map((image, index) => {
          const size = fitNodeSize(image.width, image.height, 240, 240);
          return createImageNode(positionForInput(index), {
            title: `参考图 ${index + 1}`,
            width: size.width,
            height: size.height,
            metadata: image.metadata,
          });
        });

        const targetNode = createImageNode(positionForInput(referenceNodes.length), {
          title: "目标人物/OC图",
          width: 260,
          height: 220,
          metadata: { status: "idle", canvasRole: "target" },
        });

        const inputRows = Math.max(1, Math.ceil((referenceNodes.length + 1) / cols));
        const textNode: CanvasNodeData = {
          id: nanoid(),
          type: CanvasNodeType.Text,
          title: "参考提示词",
          position: { x: baseX, y: baseY + inputRows * cellHeight + 36 },
          width: Math.max(340, cols * cellWidth - 24),
          height: 200,
          metadata: { content: promptContent, status: "idle", fontSize: 14, canvasRole: "reference-prompt" },
        };

        const upstreamNodes = [...referenceNodes, targetNode, textNode];
        const referenceTokens = referenceNodes.map((node) => `@[node:${node.id}]`).join(" ");
        const promptToken = `@[node:${textNode.id}]`;
        const targetToken = `@[node:${targetNode.id}]`;
        const composerContent = [
          referenceTokens ? `模板参考图：${referenceTokens}` : "",
          `参考提示词：${promptToken}`,
          `目标角色图：${targetToken}`,
          "",
          buildPromptGalleryCanvasPrompt(referenceNodes.length),
        ].join("\n");
        const configSpec = getNodeSpec(CanvasNodeType.Config);
        const configNode: CanvasNodeData = {
          id: nanoid(),
          type: CanvasNodeType.Config,
          title: "提示词广场生成配置",
          position: { x: baseX + cols * cellWidth + 96, y: baseY },
          width: configSpec.width,
          height: configSpec.height,
          metadata: {
            ...configSpec.metadata,
            genConfig: defaultConfig,
            composerContent,
          },
        };
        const newConnections = upstreamNodes.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }));

        pushHistory();
        setNodes((prev) => [...prev, ...upstreamNodes, configNode]);
        setConnections((prev) => [...prev, ...newConnections]);
        setSelectedConnectionId(null);
        setSelectedIds([configNode.id]);
        setPromptGalleryOpen(false);
        showToast(
          failedCount > 0
            ? `已导入模板，${failedCount} 张参考图使用远程 URL 兜底`
            : optimizedPrompt.optimized
              ? "已从提示词广场导入并优化提示词"
              : "已从提示词广场导入模板",
          "success",
        );
      } catch {
        showToast("从提示词广场导入失败", "error");
      } finally {
        setPromptGalleryImporting(false);
      }
    },
    [createImageNode, defaultConfig, promptGalleryImporting, pushHistory, showToast, viewportCenterWorld],
  );

  const applyCanvasTemplate = useCallback(
    (template: CanvasTemplate) => {
      const center = viewportCenterWorld();
      const textSpec = getNodeSpec(CanvasNodeType.Text);
      const configSpec = getNodeSpec(CanvasNodeType.Config);
      const gap = 80;

      const textNode: CanvasNodeData = {
        id: nanoid(),
        type: CanvasNodeType.Text,
        title: template.title,
        position: { x: center.x - textSpec.width - gap / 2, y: center.y - textSpec.height / 2 },
        width: textSpec.width,
        height: textSpec.height,
        metadata: { ...textSpec.metadata, content: template.prompt },
      };

      const composerContent = `参考提示词：@[node:${textNode.id}]`;
      const configNode: CanvasNodeData = {
        id: nanoid(),
        type: CanvasNodeType.Config,
        title: "流程模板生成配置",
        position: { x: center.x + configSpec.width / 2 + gap / 2, y: center.y - configSpec.height / 2 },
        width: configSpec.width,
        height: configSpec.height,
        metadata: { ...configSpec.metadata, genConfig: defaultConfig, composerContent },
      };

      const connection: CanvasConnection = { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id };

      pushHistory();
      setNodes((prev) => [...prev, textNode, configNode]);
      setConnections((prev) => [...prev, connection]);
      setSelectedConnectionId(null);
      setSelectedIds([configNode.id]);
      setTemplateOpen(false);
      showToast(`已导入模板：${template.title}`, "success");
    },
    [defaultConfig, pushHistory, showToast, viewportCenterWorld],
  );

  const handleSaveToAssets = useCallback(
    async (node: CanvasNodeData) => {
      try {
        const key = node.metadata?.storageKey;
        let blob: Blob | null = key ? await getImageBlob(key) : null;
        if (!blob) {
          const url = nodeImageUrl(node);
          if (url) blob = await (await fetch(url)).blob();
        }
        if (!blob) {
          showToast("无法读取图片", "error");
          return;
        }
        await addImageAsset({ blob, sourceKind: "manual", sourceLabel: "无限画布", name: node.title, prompt: node.metadata?.prompt });
        showToast("已存入我的素材", "success");
      } catch {
        showToast("存入素材失败", "error");
      }
    },
    [nodeImageUrl, showToast],
  );

  // ---- generation (编排节点 → 输出图片节点；走宿主任务队列；逐节点独立并发) ----
  const setBusy = useCallback((nodeId: string, busy: boolean) => {
    setBusyNodeIds((prev) => (busy ? [...new Set([...prev, nodeId])] : prev.filter((id) => id !== nodeId)));
  }, []);

  const getConfigReferenceLimit = useCallback(
    (configNode: CanvasNodeData) => {
      const promptText = configNode.metadata?.composerContent ?? configNode.metadata?.prompt ?? "";
      const genConfig: CanvasGenerationConfig = configNode.metadata?.genConfig ?? defaultConfig;
      const model = normalizeModel(genConfig.model);
      const max = typeof MODEL_IMAGE_LIMITS[model]?.max === "number" ? MODEL_IMAGE_LIMITS[model].max : 1;
      const context = buildNodeGenerationContext(configNode.id, nodes, connections, promptText);
      const exceeded = max <= 0 ? context.imageCount > 0 : context.imageCount > max;
      return { imageCount: context.imageCount, max, exceeded };
    },
    [connections, defaultConfig, nodes],
  );

  const selectedConfigNodes = useMemo(
    () => nodes.filter((node) => selectedIds.includes(node.id) && node.type === CanvasNodeType.Config),
    [nodes, selectedIds],
  );
  const previewNode = useMemo(
    () => nodes.find((node) => node.id === generationPreviewNodeId && node.type === CanvasNodeType.Config) ?? null,
    [generationPreviewNodeId, nodes],
  );
  const previewContext = useMemo(() => previewNode
    ? buildNodeGenerationContext(previewNode.id, nodes, connections, previewNode.metadata?.composerContent ?? previewNode.metadata?.prompt ?? "")
    : null, [connections, nodes, previewNode]);
  const batchPreviewItems = useMemo<CanvasBatchPreviewItem[]>(() => selectedConfigNodes.map((node) => {
    const prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
    const context = buildNodeGenerationContext(node.id, nodes, connections, prompt);
    const limit = getConfigReferenceLimit(node);
    const config = node.metadata?.genConfig ?? defaultConfig;
    const reason = !context.routeValid
      ? "路线已失效"
      : !context.prompt.trim()
        ? "提示词为空"
        : limit.exceeded
          ? "参考图超限"
          : busyNodeIds.includes(node.id)
            ? "正在生成"
            : undefined;
    return { node, valid: !reason, reason, imageCount: Number(config.count) || 1 };
  }), [busyNodeIds, connections, defaultConfig, getConfigReferenceLimit, nodes, selectedConfigNodes]);

  // ---- video generation (编排节点视频模式 → 输出视频节点；素材上传 + 插件任务轮询) ----

  // 读取节点上的视频参数（含插件选择），缺省/非法时按插件 schema 收敛出安全取值
  const effectiveVideoConfig = useCallback(
    (configNode: CanvasNodeData): { plugin: InstalledPlugin | null; facets: FacetValues; fields: FieldValues } => {
      const pluginId = configNode.metadata?.videoPluginId;
      const plugin = videoPlugins.find((item) => item.id === pluginId) ?? videoPlugins[0] ?? null;
      if (!plugin) return { plugin: null, facets: {}, fields: {} };
      const { facets, fields } = effectiveVideoState(plugin, configNode.metadata?.videoFacets, configNode.metadata?.videoFields);
      return { plugin, facets, fields };
    },
    [videoPlugins],
  );

  // 收集视频素材：帧槽（本地文件优先，回退画布图片引用）；第一个非帧图片槽聚合 @ 引用 + 本地文件；其余槽本地文件
  const collectVideoMediaSlots = useCallback(
    (sourceNode: CanvasNodeData, hydratedContext: ReturnType<typeof hydrateNodeGenerationContext> extends Promise<infer T> ? T : never): Record<string, CanvasVideoMediaItem[]> => {
      const { plugin, facets, fields } = effectiveVideoConfig(sourceNode);
      if (!plugin) return {};
      const slots = visibleCanvasMediaFields(plugin, facets, fields);
      const pending = getPendingMedia(sourceNode.id);
      const mediaSlots: Record<string, CanvasVideoMediaItem[]> = {};
      const firstImageSlot = slots.find(({ field }) => field.kind === "images" && field.style !== "frame");

      for (const { field } of slots) {
        const items: CanvasVideoMediaItem[] = [];
        const files = pending.filter((item) => item.slot === field.key);
        if (field.style === "frame") {
          if (files.length > 0) {
            for (const media of files) items.push({ id: media.id, name: media.file.name, kind: media.kind, file: media.file });
          } else {
            // 帧槽回退：引用的画布图片节点（与 canvas-node-generation 的 readReferenceImage 同一读取方式）
            const refId = sourceNode.metadata?.videoFrameRefs?.[field.key];
            const node = refId ? nodes.find((item) => item.id === refId) : undefined;
            if (node && node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) {
              const name = `${node.title || node.id}.png`;
              items.push({
                id: node.id,
                name,
                kind: "images",
                referenceImage: { id: node.id, name, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content || "", storageKey: node.metadata.storageKey },
              });
            }
          }
        } else if (field.kind === "images" && field === firstImageSlot?.field) {
          for (const ref of hydratedContext.referenceImages) {
            items.push({ id: ref.id, name: ref.name, kind: "images", referenceImage: ref });
          }
          for (const media of files) items.push({ id: media.id, name: media.file.name, kind: media.kind, file: media.file });
        } else {
          for (const media of files) items.push({ id: media.id, name: media.file.name, kind: media.kind, file: media.file });
        }
        mediaSlots[field.key] = items;
      }
      return mediaSlots;
    },
    [effectiveVideoConfig, nodes],
  );

  // 视频提交前的最终校验（与面板同一套规则；面板快照过期时这里是最后防线）
  const validateVideoSubmission = useCallback(
    (sourceNode: CanvasNodeData, promptText: string, imageCount: number): string | null => {
      const { plugin, facets, fields } = effectiveVideoConfig(sourceNode);
      if (!plugin) return "未安装视频插件";
      const promptField = findCanvasPromptField(plugin);
      const mergedFields = promptField ? { ...fields, [promptField.key]: promptText } : fields;
      return computeCanvasVideoBlockReason({
        plugin,
        facets,
        fields: mergedFields,
        imageCount,
        frameRefs: sourceNode.metadata?.videoFrameRefs ?? {},
        canvasImageIds: new Set(canvasImages.map((image) => image.id)),
        pendingMedia: getPendingMedia(sourceNode.id),
      });
    },
    [canvasImages, effectiveVideoConfig],
  );

  // 对单个结果视频节点启动独立生成任务（素材上传 + 提交 + 轮询）。
  const startVideoNodeGeneration = useCallback(
    async (nodeId: string, sourceNodeId: string, promptText: string, plugin: InstalledPlugin, facets: FacetValues, fields: FieldValues, mediaSlots: Record<string, CanvasVideoMediaItem[]>) => {
      // 取消该节点之前的任务（如有）
      activeGenerationsRef.current.get(nodeId)?.abort();
      const controller = new AbortController();
      activeGenerationsRef.current.set(nodeId, controller);

      // 先进入上传态：素材逐个上传可能耗时较久
      setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "uploading", errorDetails: undefined, generationTaskId: undefined, generationStartedAt: Date.now() } } : node)));
      setBusy(sourceNodeId, true);

      try {
        const taskId = await submitCanvasVideoGeneration({ resultNodeId: nodeId, plugin, prompt: promptText, facets, fields, mediaSlots, signal: controller.signal });
        if (controller.signal.aborted) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, generationTaskId: taskId, status: "queued" } } : node)));

        const result = await pollCanvasVideoTask(taskId, (progress) => {
          if (controller.signal.aborted) return;
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: progress.status === "queued" ? "queued" : "processing", videoProgress: progress.progress, videoUpstreamStatus: progress.upstreamStatus } } : node)));
        }, controller.signal);

        if (controller.signal.aborted) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "success", videoUrl: result.videoUrl, videoPosterUrl: result.posterUrl, videoDurationSec: result.durationSec, videoProgress: undefined, videoUpstreamStatus: undefined } } : node)));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof CanvasApiKeyMissingError) {
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "idle", generationTaskId: undefined, generationStartedAt: undefined } } : node)));
          onRequireApiKey();
        } else {
          const message = error instanceof Error ? error.message : "生成失败";
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: message } } : node)));
        }
      } finally {
        activeGenerationsRef.current.delete(nodeId);
        // 终态清理上传进度明细（error 态遮罩已换为错误提示，进度明细不再展示，清理安全）
        clearUploadProgress(nodeId);
        // 视频一次只产出一个结果节点，直接解除编排节点的忙碌状态
        setBusy(sourceNodeId, false);
      }
    },
    [onRequireApiKey, setBusy],
  );

  // 视频模式生成入口：校验素材 → 新建结果视频节点 → 上传素材并提交任务
  const runVideoGeneration = useCallback(
    async (sourceNode: CanvasNodeData) => {
      const promptText = (sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? "").trim();
      if (!promptText) { showToast("请输入提示词", "info"); return; }

      const context = buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText);
      if (!context.routeValid) { showToast("所选提示词路线已失效，请重新选择", "error"); return; }

      const { plugin, facets, fields } = effectiveVideoConfig(sourceNode);
      if (!plugin) { showToast("未安装视频插件，无法生成视频", "error"); return; }

      const validationError = validateVideoSubmission(sourceNode, promptText, context.imageCount);
      if (validationError) { showToast(validationError, "error"); return; }

      pushHistory();
      // 视频一次只生成一个结果节点，放在编排节点右侧
      const resultNode = createVideoNode({ x: sourceNode.position.x + sourceNode.width + 80, y: sourceNode.position.y }, { title: `${sourceNode.title} - 结果` });
      setNodes((prev) => [...prev, resultNode]);
      setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: resultNode.id }]);

      const hydrated = await hydrateNodeGenerationContext(context);
      const mediaSlots = collectVideoMediaSlots(sourceNode, hydrated);
      void startVideoNodeGeneration(resultNode.id, sourceNode.id, hydrated.prompt || promptText, plugin, facets, fields, mediaSlots);
    },
    [collectVideoMediaSlots, connections, createVideoNode, effectiveVideoConfig, nodes, pushHistory, showToast, startVideoNodeGeneration, validateVideoSubmission],
  );

  // 对单个结果图片节点启动独立生成任务（提交 + 轮询）。
  const startNodeGeneration = useCallback(
    async (nodeId: string, promptText: string, referenceImages: ReferenceImage[], genConfig: CanvasGenerationConfig, sourceNodeId: string) => {
      // 取消该节点之前的任务（如有）
      activeGenerationsRef.current.get(nodeId)?.abort();
      const controller = new AbortController();
      activeGenerationsRef.current.set(nodeId, controller);

      // 立即标记节点为提交中状态（同步，确保 UI 即时更新）
      setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "submitting", errorDetails: undefined, generationTaskId: undefined, generationStartedAt: Date.now() } } : node)));
      setBusy(sourceNodeId, true);

      try {
        const taskId = await submitNodeGeneration({ prompt: promptText, referenceImages, config: genConfig });
        if (controller.signal.aborted) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, generationTaskId: taskId, status: "queued" } } : node)));

        const images = await pollNodeTask(taskId, (taskStatus) => {
          if (controller.signal.aborted) return;
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: taskStatus as CanvasNodeMetadata["status"] } } : node)));
        }, controller.signal);

        if (controller.signal.aborted) return;
        const image = images[0];
        if (image) {
          const size = fitNodeSize(image.width, image.height, 360, 360);
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width: size.width, height: size.height, metadata: { ...node.metadata, ...storedToMetadata(image, { prompt: promptText }), generationTaskId: node.metadata?.generationTaskId, generationStartedAt: node.metadata?.generationStartedAt } } : node)));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof CanvasApiKeyMissingError) {
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "idle", generationTaskId: undefined, generationStartedAt: undefined } } : node)));
          onRequireApiKey();
        } else {
          const message = error instanceof Error ? error.message : "生成失败";
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: message } } : node)));
        }
      } finally {
        activeGenerationsRef.current.delete(nodeId);
        // 检查该编排节点是否还有其他活跃子任务
        let hasActive = false;
        for (const key of activeGenerationsRef.current.keys()) {
          if (key === nodeId) continue;
          const n = nodes.find((item) => item.id === key);
          if (n && n.metadata?.generationStartedAt) { hasActive = true; break; }
        }
        if (!hasActive) setBusy(sourceNodeId, false);
      }
    },
    [nodes, onRequireApiKey, setBusy],
  );

  const applyGeneratedImage = useCallback((nodeId: string, image: CanvasGeneratedImage, prompt?: string) => {
    const size = fitNodeSize(image.width, image.height, 360, 360);
    patchNode(nodeId, (node) => ({
      ...node,
      width: size.width,
      height: size.height,
      metadata: {
        ...node.metadata,
        ...storedToMetadata(image, { prompt: prompt ?? node.metadata?.prompt }),
        generationTaskId: node.metadata?.generationTaskId,
        generationStartedAt: node.metadata?.generationStartedAt,
      },
    }));
  }, [patchNode]);

  const runGeneration = useCallback(
    async (sourceNode: CanvasNodeData) => {
      // 视频模式分流：走独立的素材上传 + 插件任务链路
      const mode = sourceNode.metadata?.generationMode ?? "image";
      if (mode === "video") {
        void runVideoGeneration(sourceNode);
        return;
      }
      const promptText = (sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? "").trim();
      const genConfig: CanvasGenerationConfig = sourceNode.metadata?.genConfig ?? defaultConfig;
      const locked = Boolean(sourceNode.metadata?.lockResultNodes);
      const count = genConfig.count;
      const context = buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText);
      if (!context.routeValid) { showToast("所选提示词路线已失效，请重新选择", "error"); return; }
      if (!context.prompt.trim()) { showToast("请输入提示词", "info"); return; }
      const model = normalizeModel(genConfig.model);
      const maxReferenceImages = typeof MODEL_IMAGE_LIMITS[model]?.max === "number" ? MODEL_IMAGE_LIMITS[model].max : 1;

      if (maxReferenceImages <= 0 && context.imageCount > 0) {
        showToast("当前模型不支持参考图", "error");
        return;
      }
      if (context.imageCount > maxReferenceImages) {
        showToast("参考图超过模型限制", "error");
        return;
      }

      pushHistory();

      // 确定目标结果节点（并补齐不足的节点）
      let targetIds: string[] = [];
      const newConnections: CanvasConnection[] = [];

      if (locked) {
        // 锁定模式：复用已连接的下游图片节点，不足则新建补齐
        const existingTargets = connections
          .filter((c) => c.fromNodeId === sourceNode.id)
          .map((c) => nodes.find((n) => n.id === c.toNodeId))
          .filter((n): n is CanvasNodeData => Boolean(n && n.type === CanvasNodeType.Image));
        targetIds = existingTargets.map((n) => n.id);

        if (targetIds.length < count) {
          const needed = count - targetIds.length;
          for (let i = 0; i < needed; i++) {
            const resultIndex = targetIds.length + 1;
            const node = createImageNode(
              { x: sourceNode.position.x + sourceNode.width + 80 + (resultIndex - 1) * 400, y: sourceNode.position.y + sourceNode.height + 60 },
              { title: `${sourceNode.title} - 结果 ${resultIndex}` },
            );
            targetIds.push(node.id);
            newConnections.push({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: node.id });
            setNodes((prev) => [...prev, node]);
          }
        } else if (targetIds.length > count) {
          // 多余的锁定节点不参与本轮生成（保持原状态）
          targetIds = targetIds.slice(0, count);
        }
      } else {
        // 非锁定模式：新建 count 个结果节点
        for (let i = 0; i < count; i++) {
          const node = createImageNode(
            { x: sourceNode.position.x + sourceNode.width + 80 + i * 400, y: sourceNode.position.y },
            { title: `${sourceNode.title} - 结果 ${i + 1}` },
          );
          targetIds.push(node.id);
          newConnections.push({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: node.id });
          setNodes((prev) => [...prev, node]);
        }
      }

      if (newConnections.length) {
        setConnections((prev) => [...prev, ...newConnections]);
      }

      const hydrated = await hydrateNodeGenerationContext(context);

      // 逐节点独立并发提交
      for (const nodeId of targetIds) {
        void startNodeGeneration(nodeId, hydrated.prompt || promptText, hydrated.referenceImages, genConfig, sourceNode.id);
      }
    },
    [connections, createImageNode, defaultConfig, nodes, pushHistory, runVideoGeneration, startNodeGeneration, showToast],
  );

  // 单节点重试（带冷却）
  const RETRY_COOLDOWN_MS = 3000;
  const handleNodeRetry = useCallback(
    (node: CanvasNodeData) => {
      const now = Date.now();
      const lastRetry = retryCooldownRef.current.get(node.id) ?? 0;
      if (now - lastRetry < RETRY_COOLDOWN_MS) return;
      retryCooldownRef.current.set(node.id, now);

      // 找到连接的编排节点，取其 prompt 和 config
      const configConnection = connections.find((c) => c.toNodeId === node.id);
      const sourceNode = configConnection ? nodes.find((n) => n.id === configConnection.fromNodeId) : undefined;
      const promptText = sourceNode?.metadata?.composerContent ?? sourceNode?.metadata?.prompt ?? node.metadata?.prompt ?? "";

      // 视频节点：按当前可得素材重试（内存音视频素材刷新即丢；素材不合法时校验会 toast 拦截）
      if (node.type === CanvasNodeType.Video) {
        if (!sourceNode) { showToast("无法获取生成配置", "info"); return; }
        const { plugin, facets, fields } = effectiveVideoConfig(sourceNode);
        if (!plugin) { showToast("未安装视频插件，无法重试", "error"); return; }
        const context = buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText);
        if (!context.routeValid) { showToast("所选提示词路线已失效，请重新选择", "error"); return; }
        const validationError = validateVideoSubmission(sourceNode, promptText, context.imageCount);
        if (validationError) { showToast(validationError, "error"); return; }
        void (async () => {
          const hydrated = await hydrateNodeGenerationContext(context);
          const mediaSlots = collectVideoMediaSlots(sourceNode, hydrated);
          void startVideoNodeGeneration(node.id, sourceNode.id, hydrated.prompt || promptText, plugin, facets, fields, mediaSlots);
        })();
        return;
      }

      const genConfig = sourceNode?.metadata?.genConfig ?? defaultConfig;

      void (async () => {
        const context = sourceNode
          ? buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText)
          : { prompt: promptText, referenceImages: [], textCount: 0, imageCount: 0, routeValid: true };
        if (!context.routeValid) { showToast("所选提示词路线已失效，请重新选择", "error"); return; }
        if (!context.prompt.trim()) { showToast("无法获取提示词", "info"); return; }
        const hydrated = await hydrateNodeGenerationContext(context);
        void startNodeGeneration(node.id, hydrated.prompt || promptText, hydrated.referenceImages, genConfig, sourceNode?.id ?? "");
      })();
    },
    [collectVideoMediaSlots, connections, defaultConfig, effectiveVideoConfig, nodes, showToast, startNodeGeneration, startVideoNodeGeneration, validateVideoSubmission],
  );

  const handleRefreshProgress = useCallback(
    async (node: CanvasNodeData) => {
      const taskId = node.metadata?.generationTaskId;
      if (!taskId) {
        showToast("该节点没有可查询的任务", "info");
        return;
      }
      try {
        // 视频节点：查询插件任务链路
        if (node.type === CanvasNodeType.Video) {
          const result = await checkExistingVideoTask(taskId);
          if (result.status === "completed" && result.result) {
            const video = result.result;
            activeGenerationsRef.current.get(node.id)?.abort();
            activeGenerationsRef.current.delete(node.id);
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "success", videoUrl: video.videoUrl, videoPosterUrl: video.posterUrl, videoDurationSec: video.durationSec, videoProgress: undefined, videoUpstreamStatus: undefined } }));
            showToast("已取回生成结果", "success");
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error || "生成失败" } }));
            showToast("任务已失败", "error");
            return;
          }
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status === "queued" ? "queued" : "processing", videoProgress: result.progress, videoUpstreamStatus: result.upstreamStatus } }));
          showToast("已获取当前进度", "info");
          return;
        }

        const result = await checkExistingTask(taskId);
        if (result.status === "completed" && result.images?.length) {
          const image = result.images[0];
          activeGenerationsRef.current.get(node.id)?.abort();
          activeGenerationsRef.current.delete(node.id);
          applyGeneratedImage(node.id, image);
          showToast(image.cacheStatus === "cached" ? "已取回生成结果" : "原图暂时不可用，已保留远端结果并继续自动重试", image.cacheStatus === "cached" ? "success" : "info");
          return;
        }
        if (result.status === "failed" || result.status === "expired") {
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error || "生成失败" } }));
          showToast("任务已失败", "error");
          return;
        }
        patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status as CanvasNodeMetadata["status"] } }));
        showToast("已获取当前进度", "info");
      } catch {
        showToast("获取进度失败", "error");
      }
    },
    [applyGeneratedImage, patchNode, showToast],
  );

  // 已完成任务的图片缓存失败时，在后台按递增间隔继续取回；刷新页面后 pending 节点也会进入这里。
  useEffect(() => {
    const pendingNodes = nodes.filter((node) =>
      node.type === CanvasNodeType.Image
      && node.metadata?.generationTaskId
      && node.metadata?.status === "success"
      && node.metadata?.resultCacheStatus === "pending",
    );
    const pendingIds = new Set(pendingNodes.map((node) => node.id));

    for (const [nodeId, controller] of resultCacheRetriesRef.current) {
      if (!pendingIds.has(nodeId)) {
        controller.abort();
        resultCacheRetriesRef.current.delete(nodeId);
      }
    }

    for (const node of pendingNodes) {
      if (resultCacheRetriesRef.current.has(node.id)) continue;
      const taskId = node.metadata!.generationTaskId!;
      const controller = new AbortController();
      resultCacheRetriesRef.current.set(node.id, controller);

      void (async () => {
        try {
          for (const retryDelay of RESULT_CACHE_RETRY_DELAYS) {
            await waitForResultCacheRetry(retryDelay, controller.signal);
            const result = await checkExistingTask(taskId, 1);
            if (controller.signal.aborted) return;
            if (result.status === "completed" && result.images?.length) {
              const image = result.images[0];
              applyGeneratedImage(node.id, image);
              if (image.cacheStatus === "cached") return;
              continue;
            }
            if (result.status === "failed" || result.status === "expired") {
              patchNode(node.id, (current) => ({
                ...current,
                metadata: { ...current.metadata, resultCacheStatus: "failed", resultCacheError: result.error || "原图已无法取回" },
              }));
              return;
            }
          }
          patchNode(node.id, (current) => ({
            ...current,
            metadata: { ...current.metadata, resultCacheStatus: "failed", resultCacheError: current.metadata?.resultCacheError || "自动取回原图失败" },
          }));
        } catch (error) {
          if (controller.signal.aborted) return;
          patchNode(node.id, (current) => ({
            ...current,
            metadata: { ...current.metadata, resultCacheStatus: "failed", resultCacheError: error instanceof Error ? error.message : "自动取回原图失败" },
          }));
        } finally {
          resultCacheRetriesRef.current.delete(node.id);
        }
      })();
    }
  }, [applyGeneratedImage, nodes, patchNode]);

  useEffect(() => () => {
    for (const controller of resultCacheRetriesRef.current.values()) controller.abort();
    resultCacheRetriesRef.current.clear();
  }, []);

  // 刷新页面后恢复进行中的生成任务（检查已有 taskId 的状态）
  useEffect(() => {
    // 视频节点卡在上传阶段（无 taskId）：素材 File 只在内存里，刷新后已丢，只能置错让用户重新提交
    for (const node of nodes) {
      if (node.type === CanvasNodeType.Video && node.metadata?.status === "uploading") {
        patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: "素材上传中断（页面已刷新），请重新提交任务" } }));
      }
    }

    const activeNodes = nodes.filter((node) => {
      const s = node.metadata?.status;
      return node.metadata?.generationTaskId && (s === "submitting" || s === "queued" || s === "processing");
    });
    if (!activeNodes.length) return;

    for (const node of activeNodes) {
      const taskId = node.metadata!.generationTaskId!;
      const controller = new AbortController();
      activeGenerationsRef.current.set(node.id, controller);

      // 视频节点：查插件任务状态，终态直接写入结果，进行中则接续轮询
      if (node.type === CanvasNodeType.Video) {
        void (async () => {
          try {
            const result = await checkExistingVideoTask(taskId);
            if (controller.signal.aborted) return;

            if (result.status === "completed" && result.result) {
              const video = result.result;
              patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "success", videoUrl: video.videoUrl, videoPosterUrl: video.posterUrl, videoDurationSec: video.durationSec, videoProgress: undefined, videoUpstreamStatus: undefined } }));
              return;
            }
            if (result.status === "failed" || result.status === "expired") {
              patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error || "生成失败" } }));
              return;
            }

            // 仍在进行中 → 置当前状态后继续轮询
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status === "queued" ? "queued" : "processing", videoProgress: result.progress, videoUpstreamStatus: result.upstreamStatus } }));
            const finalResult = await pollCanvasVideoTask(taskId, (progress) => {
              if (controller.signal.aborted) return;
              patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: progress.status === "queued" ? "queued" : "processing", videoProgress: progress.progress, videoUpstreamStatus: progress.upstreamStatus } }));
            }, controller.signal);

            if (controller.signal.aborted) return;
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "success", videoUrl: finalResult.videoUrl, videoPosterUrl: finalResult.posterUrl, videoDurationSec: finalResult.durationSec, videoProgress: undefined, videoUpstreamStatus: undefined } }));
          } catch {
            if (controller.signal.aborted) return;
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: "恢复生成状态失败" } }));
          } finally {
            activeGenerationsRef.current.delete(node.id);
          }
        })();
        continue;
      }

      void (async () => {
        try {
          // 先检查当前状态
          const result = await checkExistingTask(taskId);
          if (controller.signal.aborted) return;

          if (result.status === "completed" && result.images?.length) {
            const image = result.images[0];
            applyGeneratedImage(node.id, image);
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error } }));
            return;
          }

          // 仍在进行中 → 继续轮询
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status as CanvasNodeMetadata["status"] } }));
          const images = await pollNodeTask(taskId, (taskStatus) => {
            if (controller.signal.aborted) return;
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: taskStatus as CanvasNodeMetadata["status"] } }));
          }, controller.signal);

          if (controller.signal.aborted) return;
          if (images[0]) applyGeneratedImage(node.id, images[0]);
        } catch {
          if (controller.signal.aborted) return;
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: "恢复生成状态失败" } }));
        } finally {
          activeGenerationsRef.current.delete(node.id);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅在挂载时运行一次

  // ---- node ops (dialogs) ----
  const openDialog = useCallback(
    (type: NonNullable<DialogState>["type"], node: CanvasNodeData) => {
      const source = nodeImageUrl(node);
      if (!source) return;
      setDialog({ type, nodeId: node.id, source });
    },
    [nodeImageUrl],
  );

  const applyOpResult = useCallback(
    async (nodeId: string, dataUrl: string) => {
      const stored = await uploadImage(dataUrl);
      fillNodeWithStored(nodeId, stored);
    },
    [fillNodeWithStored],
  );

  const applySplitResult = useCallback(
    async (sourceNode: CanvasNodeData, pieces: { row: number; column: number; dataUrl: string }[]) => {
      pushHistory();
      const created: CanvasNodeData[] = [];
      for (const piece of pieces) {
        const stored = await uploadImage(piece.dataUrl);
        const size = fitNodeSize(stored.width, stored.height, 220, 220);
        created.push(createImageNode({ x: sourceNode.position.x + sourceNode.width + 60 + piece.column * (size.width + 16), y: sourceNode.position.y + piece.row * (size.height + 16) }, { metadata: storedToMetadata(stored), width: size.width, height: size.height }));
      }
      setNodes((prev) => [...prev, ...created]);
    },
    [createImageNode, pushHistory],
  );

  // ---- pointer interactions (drag / connect / selection / resize) ----
  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      setSelectedConnectionId(null);
      setContextMenu(null); // 点击节点时关闭右键菜单

      // 点击节点时自动置顶（Fix 2: z-index stacking）
      topZIndexRef.current += 1;
      setNodeZIndexMap((prev) => ({ ...prev, [nodeId]: topZIndexRef.current }));

      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      let nextSelection = selectedIds;
      if (additive) {
        nextSelection = selectedIds.includes(nodeId) ? selectedIds.filter((id) => id !== nodeId) : [...selectedIds, nodeId];
      } else if (!selectedIds.includes(nodeId)) {
        nextSelection = [nodeId];
      }
      setSelectedIds(nextSelection);

      // 点击交互元素（按钮 / 输入框 / 可编辑区 / 标记 data-no-drag 的区域）时只选中、不启动拖拽；
      // 其余区域（节点空白、面板留白、标题栏、图片）均可拖动整块节点。
      const target = event.target as HTMLElement | null;
      const isInteractive =
        Boolean(target?.isContentEditable) ||
        Boolean(target?.closest('button, a, input, textarea, select, [role="slider"], [role="textbox"], [data-no-drag]'));
      if (isInteractive) return;

      beginGesture();
      const origin = new Map<string, Position>();
      for (const id of nextSelection.length ? nextSelection : [nodeId]) {
        const target = nodes.find((item) => item.id === id);
        if (target) origin.set(id, { ...target.position });
      }
      interaction.current = { kind: "drag", startX: event.clientX, startY: event.clientY, origin };
    },
    [beginGesture, nodes, selectedIds],
  );

  const handleConnectStart = useCallback(
    (event: React.PointerEvent, nodeId: string, handleType: "source" | "target") => {
      event.stopPropagation();
      interaction.current = { kind: "connect", handle: { nodeId, handleType } };
      setConnecting({ handle: { nodeId, handleType }, mouseWorld: worldFromClient(event.clientX, event.clientY) });
    },
    [worldFromClient],
  );

  const handleResizeStart = useCallback(
    (event: React.PointerEvent, nodeId: string, corner: ResizeCorner) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      beginGesture();
      interaction.current = { kind: "resize", nodeId, corner, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height, pos: { ...node.position } };
    },
    [beginGesture, nodes],
  );

  const handleCanvasSelectionStart = useCallback(
    (event: React.PointerEvent) => {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const world = worldFromClient(event.clientX, event.clientY);
      interaction.current = { kind: "selection", additive, initial: additive ? selectedIds : [] };
      setSelectionBox({ startWorldX: world.x, startWorldY: world.y, currentWorldX: world.x, currentWorldY: world.y, additive, initialSelectedNodeIds: additive ? selectedIds : [] });
    },
    [selectedIds, worldFromClient],
  );

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const current = interaction.current;
      if (!current) return;
      if (current.kind === "drag") {
        const dx = (event.clientX - current.startX) / viewport.k;
        const dy = (event.clientY - current.startY) / viewport.k;
        setNodes((prev) => prev.map((node) => (current.origin.has(node.id) ? { ...node, position: { x: current.origin.get(node.id)!.x + dx, y: current.origin.get(node.id)!.y + dy } } : node)));
      } else if (current.kind === "connect") {
        const world = worldFromClient(event.clientX, event.clientY);
        const overEl = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-node-id]") as HTMLElement | null;
        const targetId = overEl?.getAttribute("data-node-id") || undefined;
        setConnecting({ handle: current.handle, mouseWorld: world, targetId: targetId && targetId !== current.handle.nodeId ? targetId : undefined });
      } else if (current.kind === "selection") {
        const world = worldFromClient(event.clientX, event.clientY);
        setSelectionBox((prev) => (prev ? { ...prev, currentWorldX: world.x, currentWorldY: world.y } : prev));
      } else if (current.kind === "resize") {
        const dx = (event.clientX - current.startX) / viewport.k;
        const dy = (event.clientY - current.startY) / viewport.k;
        const minSize = 80;
        let width = current.width;
        let height = current.height;
        const position = { ...current.pos };
        if (current.corner.includes("right")) width = Math.max(minSize, current.width + dx);
        if (current.corner.includes("left")) {
          width = Math.max(minSize, current.width - dx);
          position.x = current.pos.x + (current.width - width);
        }
        if (current.corner.includes("bottom")) height = Math.max(minSize, current.height + dy);
        if (current.corner.includes("top")) {
          height = Math.max(minSize, current.height - dy);
          position.y = current.pos.y + (current.height - height);
        }
        setNodes((prev) => prev.map((node) => (node.id === current.nodeId ? { ...node, width, height, position } : node)));
      }
    };

    const handleUp = (event: PointerEvent) => {
      const current = interaction.current;
      if (current?.kind === "connect") {
        setConnecting((conn) => {
          if (conn?.targetId) {
            const from = current.handle.handleType === "source" ? current.handle.nodeId : conn.targetId;
            const to = current.handle.handleType === "source" ? conn.targetId : current.handle.nodeId;
            if (from !== to && !connections.some((item) => item.fromNodeId === from && item.toNodeId === to)) {
              pushHistory();
              setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: from, toNodeId: to }]);
            }
          } else {
            // 拖到空白处松开 → 弹出连线创建菜单
            setContextMenu({
              type: "connection-create",
              x: event.clientX,
              y: event.clientY,
              position: worldFromClient(event.clientX, event.clientY),
              sourceNodeId: current.handle.nodeId,
              handleType: current.handle.handleType,
            });
          }
          return null;
        });
      } else if (current?.kind === "selection") {
        setSelectionBox((box) => {
          if (box) {
            const minX = Math.min(box.startWorldX, box.currentWorldX);
            const maxX = Math.max(box.startWorldX, box.currentWorldX);
            const minY = Math.min(box.startWorldY, box.currentWorldY);
            const maxY = Math.max(box.startWorldY, box.currentWorldY);
            const inside = nodes.filter((node) => node.position.x + node.width >= minX && node.position.x <= maxX && node.position.y + node.height >= minY && node.position.y <= maxY).map((node) => node.id);
            setSelectedConnectionId(null);
            if (box.additive) {
              const next = new Set(box.initialSelectedNodeIds);
              inside.forEach((id) => next.has(id) ? next.delete(id) : next.add(id));
              setSelectedIds([...next]);
            } else {
              setSelectedIds(inside);
            }
          }
          return null;
        });
      }
      interaction.current = null;
      gestureActive.current = false;
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [connections, nodes, pushHistory, viewport.k, worldFromClient]);

  // ---- keyboard ----
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (editing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setNodeSearchOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        const selectedSet = new Set(selectedIds);
        clipboard.current = {
          nodes: nodes.filter((node) => selectedSet.has(node.id)).map((node) => ({ ...node, metadata: { ...node.metadata } })),
          connections: connections.filter((connection) => selectedSet.has(connection.fromNodeId) && selectedSet.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        if (!clipboard.current.nodes.length) return;
        event.preventDefault();
        pushHistory();
        const duplicated = duplicateCanvasSelection(clipboard.current.nodes, clipboard.current.connections, clipboard.current.nodes.map((node) => node.id), nanoid, 40);
        setNodes((prev) => [...prev, ...duplicated.nodes]);
        setConnections((prev) => [...prev, ...duplicated.connections]);
        setSelectedConnectionId(null);
        setSelectedIds(duplicated.nodes.map((node) => node.id));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedConnectionId) {
          event.preventDefault();
          deleteConnection(selectedConnectionId);
        } else if (selectedIds.length) {
          event.preventDefault();
          deleteNodes(selectedIds);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [connections, deleteConnection, deleteNodes, nodes, pushHistory, redo, selectedConnectionId, selectedIds, undo]);

  // ---- 粘贴图片/文本：选中单个同类节点则填充，否则在视口中心新建 ----
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      let imageFile: File | null = null;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          imageFile = item.getAsFile();
          break;
        }
      }
      if (!imageFile) return;
      event.preventDefault();
      const file = imageFile;
      const selectedImageNodes = nodes.filter((node) => node.type === CanvasNodeType.Image && selectedIds.includes(node.id));
      void (async () => {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const stored = await uploadImage(dataUrl);
          if (selectedImageNodes.length === 1) {
            fillNodeWithConfirm(selectedImageNodes[0].id, stored);
            return;
          }
          pushHistory();
          const size = fitNodeSize(stored.width, stored.height, 320, 320);
          const node = createImageNode(viewportCenterWorld(), { metadata: storedToMetadata(stored), width: size.width, height: size.height });
          setNodes((prev) => [...prev, node]);
          setSelectedConnectionId(null);
          setSelectedIds([node.id]);
        } catch {
          showToast("粘贴图片失败", "error");
        }
      })();
      return;
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [createImageNode, fillNodeWithConfirm, nodes, pushHistory, selectedIds, showToast, viewportCenterWorld]);

  useEffect(() => {
    const handlePasteText = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const items = event.clipboardData?.items;
      if (items) {
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (item.kind === "file" && item.type.startsWith("image/")) return;
        }
      }
      const text = event.clipboardData?.getData("text/plain").trim();
      if (!text) return;
      event.preventDefault();
      const selectedTextNodes = nodes.filter((node) => node.type === CanvasNodeType.Text && selectedIds.includes(node.id));
      if (selectedTextNodes.length === 1) {
        fillTextNodeWithConfirm(selectedTextNodes[0].id, text);
        return;
      }
      pushHistory();
      const node = createTextNode(viewportCenterWorld(), text);
      setNodes((prev) => [...prev, node]);
      setSelectedConnectionId(null);
      setSelectedIds([node.id]);
    };
    window.addEventListener("paste", handlePasteText);
    return () => window.removeEventListener("paste", handlePasteText);
  }, [createTextNode, fillTextNodeWithConfirm, nodes, pushHistory, selectedIds, viewportCenterWorld]);

  const relatedIds = useMemo(() => {
    const set = new Set<string>();
    for (const connection of connections) {
      if (selectedIds.includes(connection.fromNodeId)) set.add(connection.toNodeId);
      if (selectedIds.includes(connection.toNodeId)) set.add(connection.fromNodeId);
    }
    return set;
  }, [connections, selectedIds]);

  const activePromptRoute = useMemo(() => {
    if (selectedIds.length !== 1) return null;
    const selectedNode = nodes.find((node) => node.id === selectedIds[0]);
    if (selectedNode?.type !== CanvasNodeType.Config) return null;
    const routes = enumeratePromptRoutes(selectedNode.id, nodes, connections).routes;
    return findSelectedPromptRoute(selectedNode.metadata?.promptRouteSelection, routes);
  }, [connections, nodes, selectedIds]);
  const activeRouteNodeIds = useMemo(() => new Set(activePromptRoute?.nodeIds ?? []), [activePromptRoute]);
  const activeRouteConnectionIds = useMemo(() => new Set(activePromptRoute?.connectionIds ?? []), [activePromptRoute]);

  const nodeById = useCallback((id: string) => nodes.find((node) => node.id === id), [nodes]);
  const contextNode = contextMenu?.type === "node" ? nodeById(contextMenu.nodeId) : undefined;

  const focusNode = useCallback((node: CanvasNodeData) => {
    const scale = Math.min(Math.max(viewport.k, 0.5), 1.25);
    setViewport({
      x: viewportSize.width / 2 - (node.position.x + node.width / 2) * scale,
      y: viewportSize.height / 2 - (node.position.y + node.height / 2) * scale,
      k: scale,
    });
    setSelectedConnectionId(null);
    setSelectedIds([node.id]);
  }, [viewport.k, viewportSize.height, viewportSize.width]);

  const handleTextChange = useCallback(
    (nodeId: string, content: string) => {
      recordContinuousHistory(`text:${nodeId}`);
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, content } }));
    },
    [patchNode, recordContinuousHistory],
  );

  const runSelectedGenerations = useCallback(() => {
    const validNodes = batchPreviewItems.filter((item) => item.valid).map((item) => item.node);
    setBatchGenerationOpen(false);
    validNodes.forEach((node) => void runGeneration(node));
  }, [batchPreviewItems, runGeneration]);

  const handleConfigChange = useCallback(
    (nodeId: string, patch: Partial<CanvasGenerationConfig>) => {
      recordContinuousHistory(`config:${nodeId}`);
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, genConfig: { ...(node.metadata?.genConfig ?? defaultConfig), ...patch } } }));
      setStoreConfig(patch);
    },
    [defaultConfig, patchNode, recordContinuousHistory, setStoreConfig],
  );

  const handleArrange = useCallback((mode: CanvasArrangeMode | "graph") => {
    const targetIds = mode === "graph"
      ? selectedIds.length > 1
        ? selectedIds
        : selectedIds.length === 1
          ? connectedNodeIds(selectedIds[0], connections)
          : nodes.map((node) => node.id)
      : selectedIds;
    if (targetIds.length < 2) {
      showToast("至少需要两个节点才能排列", "info");
      return;
    }
    pushHistory();
    setNodes((current) => mode === "graph"
      ? layoutCanvasGraph(current, connections, targetIds)
      : arrangeCanvasNodes(current, targetIds, mode));
  }, [connections, nodes, pushHistory, selectedIds, showToast]);

  // ---- AI 文本生成对话框逻辑 ----
  const handleAiTextOpen = useCallback((nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== CanvasNodeType.Text) return;

    setAiTextTargetNodeId(nodeId);
    setAiTextOriginal(node.metadata?.content || "");
    setAiTextGenerated("");
    setAiTextGenerating(false);
    setAiTextError(null);
    setAiTextDialogOpen(true);
  }, [nodes]);

  const handleAiTextPromptSubmit = useCallback(async (prompt: string) => {
    const nodeId = aiTextTargetNodeId;
    if (!nodeId) return;

    let textModel;
    try {
      textModel = requireDefaultConfiguredTextModel("agent");
    } catch {
      onRequireApiKey();
      return;
    }

    setAiTextGenerating(true);
    setAiTextGenerated("");
    setAiTextError(null);

    const controller = new AbortController();

    try {
      const systemPrompt = buildAiTextSystemPrompt(aiTextOriginal);
      const body = buildSimpleProxyTextRequestBody(
        textModel.protocol,
        textModel.modelId,
        [{ type: "text", text: `用户输入：\n${prompt}` }],
        { stream: true, systemInstruction: systemPrompt, reasoningEffort: "low" }
      );

      const response = await fetch("/api/nova/proxy/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: textModel.protocol,
          baseUrl: textModel.baseUrl,
          apiKey: textModel.apiKey,
          model: textModel.modelId,
          stream: true,
          requestBody: body,
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`生成失败 (${response.status})`);
      if (!response.body) throw new Error("响应没有可读流");

      let accumulated = "";

      await readSseStream(response.body, controller.signal, (event) => {
        if (!event.data || event.data === "[DONE]") return;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(event.data); } catch { return; }
        accumulated = handleSimpleTextStreamEvent(
          textModel.protocol,
          payload,
          event.event || "",
          accumulated,
          (delta) => setAiTextGenerated((prev) => prev + delta),
          () => undefined
        );
      });

      if (controller.signal.aborted) return;

      setAiTextGenerated(accumulated);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "AI 生成失败";
      setAiTextError(message);
    } finally {
      setAiTextGenerating(false);
    }
  }, [aiTextTargetNodeId, onRequireApiKey]);

  const handleAiTextAccept = useCallback(() => {
    const nodeId = aiTextTargetNodeId;
    if (!nodeId || !aiTextGenerated) return;

    pushHistory();
    patchNode(nodeId, (n) => ({
      ...n,
      metadata: {
        ...n.metadata,
        content: aiTextGenerated,
      },
    }));
  }, [aiTextTargetNodeId, aiTextGenerated, patchNode, pushHistory]);

  const handleAiTextCancel = useCallback(() => {
    setAiTextDialogOpen(false);
    setAiTextTargetNodeId(null);
    setAiTextOriginal("");
    setAiTextGenerated("");
    setAiTextGenerating(false);
    setAiTextError(null);
  }, []);

  // ---- AI 文本生成：复用 default agent 文本模型流式生成 ----
  const handleAiGenerate = useCallback(
    async (nodeId: string, userPrompt: string) => {
      let textModel;
      try {
        textModel = requireDefaultConfiguredTextModel("agent");
      } catch {
        onRequireApiKey();
        return;
      }

      // 取消该节点已有的生成
      textGenerationControllersRef.current.get(nodeId)?.abort();
      const controller = new AbortController();
      textGenerationControllersRef.current.set(nodeId, controller);

      // 获取当前节点的现有内容
      const currentNode = nodes.find((n) => n.id === nodeId);
      const existingContent = currentNode?.metadata?.content || "";

      patchNode(nodeId, (n) => ({
        ...n,
        metadata: { ...n.metadata, isStreaming: true, streamPreview: "", lastError: undefined },
      }));

      try {
        const systemPrompt = buildAiTextSystemPrompt(existingContent);
        const body = buildSimpleProxyTextRequestBody(
          textModel.protocol,
          textModel.modelId,
          [{ type: "text", text: `用户输入：\n${userPrompt}` }],
          { stream: true, systemInstruction: systemPrompt, reasoningEffort: "low" }
        );

        const response = await fetch("/api/nova/proxy/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: textModel.protocol,
            baseUrl: textModel.baseUrl,
            apiKey: textModel.apiKey,
            model: textModel.modelId,
            stream: true,
            requestBody: body,
          }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`生成失败 (${response.status})`);
        if (!response.body) throw new Error("响应没有可读流");

        let accumulated = "";

        await readSseStream(response.body, controller.signal, (event) => {
          if (!event.data || event.data === "[DONE]") return;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(event.data); } catch { return; }
          accumulated = handleSimpleTextStreamEvent(
            textModel.protocol,
            payload,
            event.event || "",
            accumulated,
            (delta) => {
              patchNode(nodeId, (n) => ({
                ...n,
                metadata: { ...n.metadata, streamPreview: `${n.metadata?.streamPreview || ""}${delta}` },
              }));
            },
            () => undefined
          );
        });

        if (controller.signal.aborted) return;

        patchNode(nodeId, (n) => ({
          ...n,
          metadata: {
            ...n.metadata,
            content: accumulated || n.metadata?.content || "",
            isStreaming: false,
            streamPreview: undefined,
          },
        }));
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "AI 生成失败";
        patchNode(nodeId, (n) => ({
          ...n,
          metadata: { ...n.metadata, isStreaming: false, streamPreview: undefined, lastError: message },
        }));
        showToast(message, "error");
      } finally {
        textGenerationControllersRef.current.delete(nodeId);
      }
    },
    [nodes, patchNode, showToast, onRequireApiKey],
  );

  // ---- 提示词优化：结合连接的上游图片（vision）/ 文字（context） ----
  const handleOptimizePrompt = useCallback(
    async (configNode: CanvasNodeData) => {
      let textModel;
      try {
        textModel = requireDefaultConfiguredTextModel("promptOptimize");
      } catch {
        onRequireApiKey();
        return;
      }
      const promptText = (configNode.metadata?.composerContent ?? configNode.metadata?.prompt ?? "").trim();
      if (!promptText) { showToast("请输入提示词", "info"); return; }

      optimizeHandleRef.current?.abort();
      setOptimizeNodeId(configNode.id);
      setOptimizeOriginalPrompt(promptText);
      setOptimizedText("");
      setOptimizeError(null);
      setOptimizing(true);
      setOptimizeOpen(true);

      try {
        const inputs = buildNodeGenerationInputs(configNode.id, nodes, connections);
        const upstreamText = inputs
          .filter((input) => input.type === "text")
          .map((input) => input.text)
          .filter((text): text is string => Boolean(text))
          .join("\n\n");
        const imageInputs = inputs.filter((input) => Boolean(input.image));
        const hasPromptGalleryRoles = inputs.some((input) => {
          const role = nodeById(input.nodeId)?.metadata?.canvasRole;
          return role === "reference" || role === "target" || role === "reference-prompt";
        });
        const upstreamImages = (hasPromptGalleryRoles
          ? imageInputs.filter((input) => nodeById(input.nodeId)?.metadata?.canvasRole === "target")
          : imageInputs
        )
          .map((input) => input.image)
          .filter((image): image is ReferenceImage => Boolean(image));

        const images: OptimizeImageInput[] = [];
        for (const image of upstreamImages) {
          try {
            const dataUrl = await imageToDataUrl(image);
            const compressed = await compressReferenceDataUrl(dataUrl);
            images.push({ dataUrl: compressed.dataUrl, mimeType: compressed.mimeType });
          } catch {
            // 跳过无法读取的上游图片
          }
        }

        const mode = hasPromptGalleryRoles ? "canvas-prompt-gallery-config" : images.length > 0 ? "image-to-image" : "text-to-image";
        const context = [
          hasPromptGalleryRoles
            ? "这是提示词广场导入的配置节点。优化时不要读取模板参考图，只使用已提供的目标角色/OC图；不要把目标角色/OC图转写成外貌文字，请保留并强化对用户上传角色图的引用，让生图模型直接参考图片理解角色。"
            : "",
          upstreamText ? `已连接的上游文字参考：\n${upstreamText}` : "",
        ].filter(Boolean).join("\n\n") || undefined;

        optimizeHandleRef.current = streamPromptOptimize(
          { apiKey: textModel.apiKey, model: textModel.id, mode, prompt: promptText, images, context },
          {
            onDelta(token) { setOptimizedText((prev) => prev + token); },
            onDone() { setOptimizing(false); },
            onError(err) { setOptimizeError(err.message); setOptimizing(false); },
          },
          textModel.baseUrl,
        );
      } catch (err) {
        setOptimizeError(err instanceof Error ? err.message : String(err));
        setOptimizing(false);
      }
    },
    [connections, nodeById, nodes, onRequireApiKey, showToast],
  );

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText("");
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText && optimizeNodeId) {
      pushHistory();
      patchNode(optimizeNodeId, (node) => ({ ...node, metadata: { ...node.metadata, composerContent: optimizedText } }));
    }
    optimizeHandleRef.current = null;
    setOptimizedText("");
    setOptimizeError(null);
  }, [optimizedText, optimizeNodeId, patchNode, pushHistory]);

  const selectionRect = useMemo(() => {
    if (!selectionBox) return null;
    return {
      x: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
      y: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
      width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
      height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
    };
  }, [selectionBox]);

  return (
    <div className="relative h-full w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          const targetId = uploadTargetRef.current;
          uploadTargetRef.current = null;
          if (files && files.length) {
            if (targetId) {
              const file = Array.from(files).find((item) => item.type.startsWith("image/"));
              if (file) {
                void (async () => {
                  try {
                    const dataUrl = await readFileAsDataUrl(file);
                    const stored = await uploadImage(dataUrl);
                    fillNodeWithConfirm(targetId, stored);
                  } catch {
                    showToast("图片读取失败", "error");
                  }
                })();
              }
            } else {
              void ingestFiles(files);
            }
          }
          event.target.value = "";
        }}
      />

      <InfiniteCanvas
        containerRef={containerRef}
        viewport={viewport}
        interactionMode={interactionMode}
        backgroundMode={backgroundMode}
        onViewportChange={setViewport}
        onCanvasMouseDown={handleCanvasSelectionStart}
        onCanvasDeselect={() => { setSelectedIds([]); setSelectedConnectionId(null); setContextMenu(null); if (titleDraft !== null) { renameProject(projectId, titleDraft); setTitleDraft(null); } }}
        onContextMenu={(event) => {
          event.preventDefault();
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest("[data-node-id],[data-connection-id]")) return;
          setSelectedIds([]);
          setSelectedConnectionId(null);
          setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, position: worldFromClient(event.clientX, event.clientY) });
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer?.files?.length) void ingestFiles(event.dataTransfer.files, worldFromClient(event.clientX, event.clientY));
        }}
      >
        <svg className="pointer-events-none absolute overflow-visible" style={{ width: 1, height: 1 }}>
          {connections.map((connection) => {
            const from = nodeById(connection.fromNodeId);
            const to = nodeById(connection.toNodeId);
            if (!from || !to) return null;
            const endpointSelected = selectedIds.includes(connection.fromNodeId) || selectedIds.includes(connection.toNodeId);
            const active = selectedConnectionId === connection.id || (!activePromptRoute && endpointSelected);
            const routeActive = activeRouteConnectionIds.has(connection.id);
            return (
              <g key={connection.id} className="pointer-events-auto">
                <ConnectionPath
                  connection={connection}
                  from={from}
                  to={to}
                  active={active}
                  routeActive={routeActive}
                  onSelect={() => {
                    setSelectedIds([]);
                    setSelectedConnectionId(connection.id);
                    setContextMenu(null);
                  }}
                  onContextMenu={(event) => {
                    setSelectedIds([]);
                    setSelectedConnectionId(connection.id);
                    setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                  }}
                />
              </g>
            );
          })}
          {connecting && <ActiveConnectionPath node={nodeById(connecting.handle.nodeId)} handle={connecting.handle} mouseWorld={connecting.mouseWorld} target={connecting.targetId ? nodeById(connecting.targetId) : undefined} />}
        </svg>

        {nodes.map((node) => {
          const referenceLimit = node.type === CanvasNodeType.Config ? getConfigReferenceLimit(node) : null;
          const routeEnumeration = node.type === CanvasNodeType.Config
            ? enumeratePromptRoutes(node.id, nodes, connections)
            : { routes: [], truncated: false };
          const routeSelection = node.metadata?.promptRouteSelection ?? { mode: "manual" as const };
          const selectedRoute = findSelectedPromptRoute(routeSelection, routeEnumeration.routes);
          const routeInvalid = isInvalidPromptRouteSelection(routeSelection, routeEnumeration.routes);
          const routeValue = routeInvalid
            ? "invalid"
            : selectedRoute?.id ?? MANUAL_PROMPT_ROUTE_VALUE;
          const routeOptions = [
            { value: MANUAL_PROMPT_ROUTE_VALUE, label: "手动编排（@ 引用）" },
            ...(routeInvalid ? [{ value: "invalid", label: "所选路线已失效，请重新选择", disabled: true }] : []),
            ...routeEnumeration.routes.map((route) => ({ value: route.id, label: route.label })),
          ];
          return (
            <CanvasNode
              key={node.id}
              data={node}
              imageUrl={nodeImageUrl(node)}
              isSelected={selectedIds.includes(node.id)}
              isRelated={relatedIds.has(node.id)}
              isRouteActive={activeRouteNodeIds.has(node.id)}
              isConnectionTarget={connecting?.targetId === node.id}
              referenceLimitExceeded={Boolean(referenceLimit?.exceeded)}
              zIndex={nodeZIndexMap[node.id] ?? 1}
              showImageInfo={showImageInfo}
              onPointerDownNode={handleNodePointerDown}
              onSelectNode={(id) => { setSelectedConnectionId(null); if (!selectedIds.includes(id)) setSelectedIds([id]); }}
              onContextMenu={(event, id) => {
                event.preventDefault();
                setSelectedConnectionId(null);
                if (!selectedIds.includes(id)) setSelectedIds([id]);
                setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
              }}
              onConnectStart={handleConnectStart}
              onResizeStart={handleResizeStart}
              onTitleChange={(nodeId, title) => {
                pushHistory();
                patchNode(nodeId, (current) => ({ ...current, title }));
              }}
              onContentChange={handleTextChange}
              onUploadToNode={handleNodeUpload}
              onImportToNode={handleNodeImport}
              onImportTextToNode={handleTextNodeImport}
              onSaveToAssets={handleSaveToAssets}
              onSaveTextToAssets={handleSaveTextToAssets}
              onRetry={handleNodeRetry}
              onRefreshProgress={handleRefreshProgress}
              onOpenImage={(target) => {
                const url = nodeImageUrl(target);
                if (url) {
                  const payload: ImageActionPayload = {
                    id: target.id,
                    name: target.title,
                    src: url,
                    sourceKind: 'manual',
                    sourceLabel: '无限画布',
                    sourceRef: target.metadata?.storageKey ?? target.id,
                    prompt: target.metadata?.prompt,
                  };
                  setFullscreenImageUrl({ src: url, title: target.title, actionPayload: payload });
                }
              }}
              onToggleRenderMode={(nodeId) => {
                pushHistory();
                patchNode(nodeId, (n) => ({
                  ...n,
                  metadata: { ...n.metadata, renderMode: n.metadata?.renderMode === "markdown" ? "plain" : "markdown" },
                }));
              }}
              onAiGenerate={handleAiTextOpen}
              renderPanel={(configNode, onSelect) => {
                const { plugin: videoPlugin, facets: videoFacets, fields: videoFields } = effectiveVideoConfig(configNode);
                return (
                <CanvasConfigNodePanel
                  prompt={configNode.metadata?.composerContent || ""}
                  references={buildNodeMentionReferences(configNode, nodes, connections, imageUrls)}
                  config={configNode.metadata?.genConfig ?? defaultConfig}
                  lockResultNodes={Boolean(configNode.metadata?.lockResultNodes)}
                  referenceLimit={referenceLimit ?? getConfigReferenceLimit(configNode)}
                  routeValue={routeValue}
                  routeOptions={routeOptions}
                  routeInvalid={routeInvalid}
                  routesTruncated={routeEnumeration.truncated}
                  busy={busyNodeIds.includes(configNode.id)}
                  optimizing={optimizing && optimizeNodeId === configNode.id}
                  generationMode={configNode.metadata?.generationMode ?? "image"}
                  onGenerationModeChange={(mode) => {
                    // 切回图片模式时清空内存素材（File 不持久化，留着只会让下一次生成误读）
                    if (mode === "image") clearPendingMedia(configNode.id);
                    patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, generationMode: mode } }));
                  }}
                  videoConfig={{
                    configNodeId: configNode.id,
                    plugins: videoPlugins,
                    plugin: videoPlugin,
                    facets: videoFacets,
                    fields: videoFields,
                    frameRefs: configNode.metadata?.videoFrameRefs ?? {},
                    canvasImages,
                    imageCount: referenceLimit?.imageCount ?? 0,
                    onPluginChange: (pluginId) => {
                      // 换插件：参数与帧引用随旧插件 schema 失效，一并重置
                      pushHistory();
                      clearPendingMedia(configNode.id);
                      patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, videoPluginId: pluginId, videoFacets: undefined, videoFields: undefined, videoFrameRefs: undefined } }));
                    },
                    onFacetsChange: (facets) => {
                      recordContinuousHistory(`video-config:${configNode.id}`);
                      patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, videoFacets: facets } }));
                    },
                    onFieldsChange: (patch) => {
                      recordContinuousHistory(`video-config:${configNode.id}`);
                      patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, videoFields: { ...(n.metadata?.videoFields ?? {}), ...patch } } }));
                    },
                    onFrameRefChange: (patch) => {
                      patchNode(configNode.id, (n) => {
                        const nextRefs = { ...(n.metadata?.videoFrameRefs ?? {}) };
                        for (const [slot, refId] of Object.entries(patch)) {
                          if (refId === undefined) delete nextRefs[slot];
                          else nextRefs[slot] = refId;
                        }
                        return { ...n, metadata: { ...n.metadata, videoFrameRefs: nextRefs } };
                      });
                    },
                  }}
                  onPromptChange={(value) => {
                    recordContinuousHistory(`prompt:${configNode.id}`);
                    patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, composerContent: value } }));
                  }}
                  onConfigChange={(patch) => handleConfigChange(configNode.id, patch)}
                  onToggleLock={() => {
                    pushHistory();
                    patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, lockResultNodes: !n.metadata?.lockResultNodes } }));
                  }}
                  onRouteChange={(value) => {
                    pushHistory();
                    if (value === MANUAL_PROMPT_ROUTE_VALUE) {
                      patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, promptRouteSelection: { mode: "manual" } } }));
                      return;
                    }
                    const route = routeEnumeration.routes.find((item) => item.id === value);
                    if (!route) return;
                    patchNode(configNode.id, (n) => ({
                      ...n,
                      metadata: { ...n.metadata, promptRouteSelection: { mode: "route", connectionIds: route.connectionIds } },
                    }));
                  }}
                  onSelect={onSelect}
                  onOptimizePrompt={() => void handleOptimizePrompt(configNode)}
                  onPreview={() => setGenerationPreviewNodeId(configNode.id)}
                  onGenerate={() => void runGeneration(configNode)}
                />
                );
              }}
            />
          );
        })}

        {selectionRect && (
          <div
            className="pointer-events-none absolute rounded-md border-2"
            style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height, borderColor: theme.canvas.selectionStroke, background: theme.canvas.selectionFill }}
          />
        )}
      </InfiniteCanvas>

      {/* 顶部返回 + 标题（点击重命名） */}
      <div data-canvas-no-zoom className="absolute top-4 left-4 z-50 flex items-center gap-2" onPointerDown={(event) => event.stopPropagation()}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void flushPendingCanvasSave().then(onBack);
          }}
        >
          <ArrowLeft className="size-4" />
          画布列表
        </Button>
        {titleDraft !== null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              renameProject(projectId, titleDraft);
              setTitleDraft(null);
            }}
          >
            <Input
              autoFocus
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                renameProject(projectId, titleDraft);
                setTitleDraft(null);
              }}
              className="h-7 w-44 text-xs"
            />
          </form>
        ) : (
          <button
            type="button"
            title="点击重命名"
            onClick={() => setTitleDraft(projectTitle)}
            className="max-w-44 truncate rounded-lg border border-border bg-card/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            {projectTitle}
          </button>
        )}
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground" aria-live="polite">
          {saveStatus === "saving" ? <LoaderCircle className="size-3 animate-spin" /> : saveStatus === "error" ? <CloudAlert className="size-3 text-destructive" /> : <Check className="size-3" />}
          {saveStatus === "saving" ? "保存中" : saveStatus === "error" ? "保存失败" : "已保存"}
        </span>
      </div>

      <CanvasToolbar
        selectedCount={selectedIds.length + (selectedConnectionId ? 1 : 0)}
        nodeCount={nodes.length}
        selectedConfigCount={selectedConfigNodes.length}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        backgroundMode={backgroundMode}
        showImageInfo={showImageInfo}
        interactionMode={interactionMode}
        showPromptGallery={showPromptGallery}
        onAddImage={() => addNode(CanvasNodeType.Image)}
        onAddText={() => addNode(CanvasNodeType.Text)}
        onAddAnnotation={() => addNode(CanvasNodeType.TextAnnotation)}
        onAddConfig={() => addNode(CanvasNodeType.Config)}
        onImportPromptGallery={() => setPromptGalleryOpen(true)}
        onOpenTemplate={() => setTemplateOpen(true)}
        onUndo={undo}
        onRedo={redo}
        onDelete={() => selectedConnectionId ? deleteConnection(selectedConnectionId) : deleteNodes(selectedIds)}
        onArrange={handleArrange}
        onGenerateSelected={() => setBatchGenerationOpen(true)}
        onSearch={() => setNodeSearchOpen(true)}
        onBackgroundModeChange={setBackgroundMode}
        onShowImageInfoChange={setShowImageInfo}
        onInteractionModeChange={setInteractionMode}
      />

      <CanvasZoomControls
        scale={viewport.k}
        onScaleChange={(scale) => {
          const center = { x: viewportSize.width / 2, y: viewportSize.height / 2 };
          const worldX = (center.x - viewport.x) / viewport.k;
          const worldY = (center.y - viewport.y) / viewport.k;
          setViewport({ k: scale, x: center.x - worldX * scale, y: center.y - worldY * scale });
        }}
        onReset={() => {
          // 重置视图：将所有节点内容居中并自动缩放，保证全部可见（Fix 7）
          if (!nodes.length) { setViewport({ x: 0, y: 0, k: 1 }); return; }
          const PAD = 80;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          nodes.forEach((node) => {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
            maxY = Math.max(maxY, node.position.y + node.height);
          });
          const contentW = maxX - minX + PAD * 2;
          const contentH = maxY - minY + PAD * 2;
          const scale = Math.min(viewportSize.width / contentW, viewportSize.height / contentH, 1);
          const centeredX = (viewportSize.width - (maxX + minX) * scale) / 2;
          const centeredY = (viewportSize.height - (maxY + minY) * scale) / 2;
          setViewport({ x: centeredX, y: centeredY, k: scale });
        }}
        isMiniMapOpen={miniMapOpen}
        onToggleMiniMap={() => setMiniMapOpen((open) => !open)}
      />

      {miniMapOpen && <Minimap nodes={nodes} viewport={viewport} viewportSize={viewportSize} onViewportChange={setViewport} />}

      <CanvasContextMenu
        state={contextMenu}
        node={contextNode}
        onClose={() => setContextMenu(null)}
        actions={{
          onGenerate: () => contextNode?.type === CanvasNodeType.Config && void runGeneration(contextNode),
          onDuplicate: () => contextMenu?.type === "node" && duplicateNodes([contextMenu.nodeId]),
          onDelete: () => contextMenu?.type === "node" && deleteNodes(selectedIds.length ? selectedIds : [contextMenu.nodeId]),
          onDeleteImageOnly: () => contextNode && clearNodeImage(contextNode.id),
          onRetry: () => contextNode && handleNodeRetry(contextNode),
          onCrop: () => contextNode && openDialog("crop", contextNode),
          onSplit: () => contextNode && openDialog("split", contextNode),
          onUpscale: () => contextNode && openDialog("upscale", contextNode),
          onAngle: () => contextNode && openDialog("angle", contextNode),
          onDeleteConnection: () => {
            if (contextMenu?.type === "connection") {
              deleteConnection(contextMenu.connectionId);
            }
          },
          onAddNodeAt: (type) => {
            if (contextMenu?.type === "canvas") addNode(type, contextMenu.position);
          },
          onConnectionCreate: (type) => {
            if (contextMenu?.type !== "connection-create") return;
            const { position, sourceNodeId, handleType } = contextMenu;
            pushHistory();
            const spec = getNodeSpec(type);
            const metadata: CanvasNodeMetadata = { ...spec.metadata };
            if (type === CanvasNodeType.Config) metadata.genConfig = defaultConfig;
            const newNode: CanvasNodeData = {
              id: nanoid(),
              type,
              title: spec.title,
              position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
              width: spec.width,
              height: spec.height,
              metadata,
            };
            const from = handleType === "source" ? sourceNodeId : newNode.id;
            const to = handleType === "source" ? newNode.id : sourceNodeId;
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: from, toNodeId: to }]);
            setSelectedConnectionId(null);
            setSelectedIds([newNode.id]);
          },
          onPasteAt: () => {
            if (contextMenu?.type === "canvas") pasteClipboardAt(contextMenu.position);
          },
          canPaste: clipboard.current.nodes.length > 0,
          onToggleRenderMode: contextNode?.type === CanvasNodeType.Text
            ? () => {
                pushHistory();
                patchNode(contextNode.id, (n) => ({
                  ...n,
                  metadata: { ...n.metadata, renderMode: n.metadata?.renderMode === "markdown" ? "plain" : "markdown" },
                }));
              }
            : undefined,
          onAnnotationChangeColor: contextNode?.type === CanvasNodeType.TextAnnotation
            ? () => {
                pushHistory();
                const colors = ["#fef3c7", "#dbeafe", "#fce7f3", "#d1fae5", "#fce4ec", "#ede9fe"];
                const current = contextNode.metadata?.backgroundColor || "";
                const next = colors[(colors.indexOf(current) + 1) % colors.length];
                patchNode(contextNode.id, (n) => ({
                  ...n,
                  metadata: { ...n.metadata, backgroundColor: next === colors[0] ? undefined : next },
                }));
              }
            : undefined,
          onAnnotationChangeFontSize: contextNode?.type === CanvasNodeType.TextAnnotation
            ? () => {
                pushHistory();
                const sizes = [14, 16, 18, 20, 22, 24];
                const current = contextNode.metadata?.fontSize || 14;
                const next = sizes[(sizes.indexOf(current) + 1) % sizes.length];
                patchNode(contextNode.id, (n) => ({
                  ...n,
                  metadata: { ...n.metadata, fontSize: next },
                }));
              }
            : undefined,
        }}
      />

      <AgentAssetPickerDialog open={assetPicker.open} maxSelected={1} onOpenChange={(open) => setAssetPicker((prev) => ({ ...prev, open }))} onConfirm={(assets) => void handleAssetPickerConfirm(assets)} />
      <AgentTextAssetPickerDialog open={textAssetPicker.open} onOpenChange={(open) => setTextAssetPicker((prev) => ({ ...prev, open }))} onConfirm={handleTextAssetPickerConfirm} />

      <CanvasPromptGalleryImportDialog open={promptGalleryOpen} importing={promptGalleryImporting} onOpenChange={setPromptGalleryOpen} onConfirm={(prompt) => void importPromptGalleryTemplate(prompt)} />

      <CanvasTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} onConfirm={(template) => applyCanvasTemplate(template)} />

      <CanvasGenerationPreviewDialog
        open={Boolean(previewNode)}
        onOpenChange={(open) => !open && setGenerationPreviewNodeId(null)}
        node={previewNode}
        context={previewContext}
        config={previewNode?.metadata?.genConfig ?? defaultConfig}
        onCopy={(text) => {
          void navigator.clipboard?.writeText(text);
          showToast("最终提示词已复制", "success");
        }}
      />

      <CanvasBatchGenerationDialog open={batchGenerationOpen} onOpenChange={setBatchGenerationOpen} items={batchPreviewItems} onConfirm={runSelectedGenerations} />

      <CanvasNodeSearchDialog open={nodeSearchOpen} onOpenChange={setNodeSearchOpen} nodes={nodes} onSelect={focusNode} />

      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={(open) => { if (!open) handleOptimizeCancel(); setOptimizeOpen(open); }}
        originalPrompt={optimizeOriginalPrompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />

      <AiTextGenerateDialog
        open={aiTextDialogOpen}
        onOpenChange={setAiTextDialogOpen}
        originalContent={aiTextOriginal}
        generatedContent={aiTextGenerated}
        loading={aiTextGenerating}
        error={aiTextError}
        onPromptSubmit={handleAiTextPromptSubmit}
        onAccept={handleAiTextAccept}
        onCancel={handleAiTextCancel}
      />

      <Dialog open={Boolean(replaceConfirm)} onOpenChange={(open) => !open && setReplaceConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>替换图片</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">该节点已有图片，是否替换为新图片？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceConfirm(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (replaceConfirm) fillNodeWithStored(replaceConfirm.nodeId, replaceConfirm.stored);
                setReplaceConfirm(null);
              }}
            >
              替换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(textReplaceConfirm)} onOpenChange={(open) => !open && setTextReplaceConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>覆盖文本</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">该文本节点已有内容，是否用素材内容覆盖？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTextReplaceConfirm(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (textReplaceConfirm) fillTextNode(textReplaceConfirm.nodeId, textReplaceConfirm.content);
                setTextReplaceConfirm(null);
              }}
            >
              覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dialog?.type === "crop" && <CanvasCropDialog open source={dialog.source} onClose={() => setDialog(null)} onApply={(dataUrl) => void applyOpResult(dialog.nodeId, dataUrl)} />}
      {dialog?.type === "upscale" && <CanvasUpscaleDialog open source={dialog.source} onClose={() => setDialog(null)} onApply={(dataUrl) => void applyOpResult(dialog.nodeId, dataUrl)} />}
      {dialog?.type === "angle" && <CanvasAngleDialog open source={dialog.source} onClose={() => setDialog(null)} onApply={(dataUrl) => void applyOpResult(dialog.nodeId, dataUrl)} />}
      {dialog?.type === "split" && (
        <CanvasSplitDialog
          open
          source={dialog.source}
          onClose={() => setDialog(null)}
          onApply={(pieces) => {
            const node = nodeById(dialog.nodeId);
            if (node) void applySplitResult(node, pieces);
          }}
        />
      )}

      {fullscreenImageUrl && (
        <FullscreenImageViewer src={fullscreenImageUrl.src} title={fullscreenImageUrl.title} onClose={() => setFullscreenImageUrl(null)} actionPayload={fullscreenImageUrl.actionPayload} />
      )}
    </div>
  );
}
