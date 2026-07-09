"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
import { FullscreenImageViewer } from "./components/fullscreen-image-viewer";
import type { ImageActionPayload } from "@/lib/image-actions";
import { CanvasCropDialog, CanvasUpscaleDialog, CanvasSplitDialog, CanvasAngleDialog } from "./components/canvas-node-dialogs";
import { canvasTheme } from "./lib/canvas-theme";
import { getNodeSpec } from "./constants";
import { useCanvasStore } from "./stores/use-canvas-store";
import { useCanvasConfigStore } from "./stores/use-canvas-config-store";
import { CanvasApiKeyMissingError, submitNodeGeneration, pollNodeTask, checkExistingTask, type CanvasGeneratedImage } from "./canvas-generation-service";
import { buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext } from "./components/canvas-node-generation";
import { buildNodeMentionReferences } from "./utils/canvas-resource-references";
import { fitNodeSize } from "./utils/canvas-node-size";
import { getImageBlob, imageToDataUrl, resolveImageUrl, uploadImage, type UploadedImage } from "./lib/image-storage";
import { imageReferenceLabel } from "./lib/image-reference-prompt";
import { compressReferenceDataUrl, readFileAsDataUrl } from "./lib/image-utils";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationConfig, type CanvasNodeData, type CanvasNodeMetadata, type ContextMenuState, type ConnectionHandle, type Position, type SelectionBox, type ViewportTransform } from "./types";
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
  return { status: "success", content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, ...extra };
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

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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
  const clipboard = useRef<CanvasNodeData[]>([]);
  const activeGenerationsRef = useRef<Map<string, AbortController>>(new Map());
  const retryCooldownRef = useRef<Map<string, number>>(new Map());
  const textGenerationControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([]);

  // 提示词优化（结合连接的上游图片/文字引用）
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeNodeId, setOptimizeNodeId] = useState<string | null>(null);
  const [optimizeOriginalPrompt, setOptimizeOriginalPrompt] = useState("");
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

  // ---- persistence: sync local state to store (store debounces IndexedDB writes) ----
  useEffect(() => {
    if (!project) return;
    updateProject(projectId, { nodes, connections, viewport, backgroundMode, showImageInfo });
  }, [nodes, connections, viewport, backgroundMode, showImageInfo, project, projectId, updateProject]);

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

  // ---- history helpers ----
  const snapshot = useCallback((): HistorySnapshot => ({ nodes: nodes.map((node) => ({ ...node, metadata: { ...node.metadata } })), connections: connections.map((connection) => ({ ...connection })) }), [nodes, connections]);
  const pushHistory = useCallback(() => {
    setUndoStack((stack) => {
      const next = [...stack, snapshot()];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setRedoStack([]);
  }, [snapshot]);
  const beginGesture = useCallback(() => {
    if (gestureActive.current) return;
    gestureActive.current = true;
    pushHistory();
  }, [pushHistory]);
  const undo = useCallback(() => {
    if (!undoStack.length) return;
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((redo) => [...redo, snapshot()]);
    setUndoStack((stack) => stack.slice(0, -1));
    setNodes(previous.nodes);
    setConnections(previous.connections);
  }, [snapshot, undoStack]);
  const redo = useCallback(() => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((stack) => [...stack, snapshot()]);
    setRedoStack((redo) => redo.slice(0, -1));
    setNodes(next.nodes);
    setConnections(next.connections);
  }, [snapshot, redoStack]);

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
    (type: CanvasNodeType) => {
      pushHistory();
      const spec = getNodeSpec(type);
      const center = viewportCenterWorld();
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
      setSelectedIds([node.id]);
    },
    [defaultConfig, pushHistory, viewportCenterWorld],
  );

  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      pushHistory();
      const idSet = new Set(ids);
      setNodes((prev) => prev.filter((node) => !idSet.has(node.id)));
      setConnections((prev) => prev.filter((connection) => !idSet.has(connection.fromNodeId) && !idSet.has(connection.toNodeId)));
      setSelectedIds((prev) => prev.filter((id) => !idSet.has(id)));
    },
    [pushHistory],
  );

  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const sources = nodes.filter((node) => idSet.has(node.id));
      if (!sources.length) return;
      pushHistory();
      const clones = sources.map((node) => ({ ...node, id: nanoid(), position: { x: node.position.x + 32, y: node.position.y + 32 }, metadata: { ...node.metadata } }));
      setNodes((prev) => [...prev, ...clones]);
      setSelectedIds(clones.map((node) => node.id));
    },
    [nodes, pushHistory],
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
      const max = MODEL_IMAGE_LIMITS[model]?.max || 1;
      const context = buildNodeGenerationContext(configNode.id, nodes, connections, promptText);
      return { imageCount: context.imageCount, max, exceeded: context.imageCount > max };
    },
    [connections, defaultConfig, nodes],
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

  const runGeneration = useCallback(
    async (sourceNode: CanvasNodeData) => {
      const promptText = (sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? "").trim();
      if (!promptText) { showToast("请输入提示词", "info"); return; }
      const genConfig: CanvasGenerationConfig = sourceNode.metadata?.genConfig ?? defaultConfig;
      const locked = Boolean(sourceNode.metadata?.lockResultNodes);
      const count = genConfig.count;
      const context = buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText);
      const model = normalizeModel(genConfig.model);
      const maxReferenceImages = MODEL_IMAGE_LIMITS[model]?.max || 1;

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
            const node = createImageNode({ x: sourceNode.position.x + sourceNode.width + 80 + (targetIds.length + i) * 400, y: sourceNode.position.y + sourceNode.height + 60 });
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
          const node = createImageNode({ x: sourceNode.position.x + sourceNode.width + 80 + i * 400, y: sourceNode.position.y });
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
    [connections, createImageNode, defaultConfig, nodes, pushHistory, startNodeGeneration, showToast],
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
      const genConfig = sourceNode?.metadata?.genConfig ?? defaultConfig;
      if (!promptText) { showToast("无法获取提示词", "info"); return; }

      void (async () => {
        const context = sourceNode ? buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText) : { prompt: promptText, referenceImages: [], textCount: 0, imageCount: 0 };
        const hydrated = await hydrateNodeGenerationContext(context);
        void startNodeGeneration(node.id, hydrated.prompt || promptText, hydrated.referenceImages, genConfig, sourceNode?.id ?? "");
      })();
    },
    [connections, defaultConfig, nodes, startNodeGeneration, showToast],
  );

  const handleRefreshProgress = useCallback(
    async (node: CanvasNodeData) => {
      const taskId = node.metadata?.generationTaskId;
      if (!taskId) {
        showToast("该节点没有可查询的任务", "info");
        return;
      }
      try {
        const result = await checkExistingTask(taskId);
        if (result.status === "completed" && result.images?.length) {
          const image = result.images[0];
          const size = fitNodeSize(image.width, image.height, 360, 360);
          activeGenerationsRef.current.get(node.id)?.abort();
          activeGenerationsRef.current.delete(node.id);
          patchNode(node.id, (n) => ({ ...n, width: size.width, height: size.height, metadata: { ...n.metadata, ...storedToMetadata(image, { prompt: n.metadata?.prompt }), generationTaskId: n.metadata?.generationTaskId, generationStartedAt: n.metadata?.generationStartedAt } }));
          showToast("已取回生成结果", "success");
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
    [patchNode, showToast],
  );

  // 刷新页面后恢复进行中的生成任务（检查已有 taskId 的状态）
  useEffect(() => {
    const activeNodes = nodes.filter((node) => {
      const s = node.metadata?.status;
      return node.metadata?.generationTaskId && (s === "submitting" || s === "queued" || s === "processing");
    });
    if (!activeNodes.length) return;

    for (const node of activeNodes) {
      const taskId = node.metadata!.generationTaskId!;
      const controller = new AbortController();
      activeGenerationsRef.current.set(node.id, controller);

      void (async () => {
        try {
          // 先检查当前状态
          const result = await checkExistingTask(taskId);
          if (controller.signal.aborted) return;

          if (result.status === "completed" && result.images?.length) {
            const image = result.images[0];
            const size = fitNodeSize(image.width, image.height, 360, 360);
            patchNode(node.id, (n) => ({ ...n, width: size.width, height: size.height, metadata: { ...n.metadata, ...storedToMetadata(image, { prompt: n.metadata?.prompt }), generationTaskId: n.metadata?.generationTaskId, generationStartedAt: n.metadata?.generationStartedAt } }));
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error } }));
            return;
          }

          // 仍在进行中 → 继续轮询
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status as CanvasNodeMetadata["status"] } }));
          await pollNodeTask(taskId, (taskStatus) => {
            if (controller.signal.aborted) return;
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: taskStatus as CanvasNodeMetadata["status"] } }));
          }, controller.signal);

          if (controller.signal.aborted) return;
          const finalResult = await checkExistingTask(taskId);
          if (finalResult.images?.length) {
            const image = finalResult.images[0];
            const size = fitNodeSize(image.width, image.height, 360, 360);
            patchNode(node.id, (n) => ({ ...n, width: size.width, height: size.height, metadata: { ...n.metadata, ...storedToMetadata(image, { prompt: n.metadata?.prompt }), generationTaskId: n.metadata?.generationTaskId, generationStartedAt: n.metadata?.generationStartedAt } }));
          }
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
      const additive = event.shiftKey;
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

    const handleUp = () => {
      const current = interaction.current;
      if (current?.kind === "connect") {
        setConnecting((conn) => {
          if (conn?.targetId) {
            const from = current.handle.handleType === "source" ? current.handle.nodeId : conn.targetId;
            const to = current.handle.handleType === "source" ? conn.targetId : current.handle.nodeId;
            if (from !== to) {
              setConnections((prev) => (prev.some((item) => item.fromNodeId === from && item.toNodeId === to) ? prev : [...prev, { id: nanoid(), fromNodeId: from, toNodeId: to }]));
            }
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
            setSelectedIds([...new Set([...box.initialSelectedNodeIds, ...inside])]);
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
  }, [nodes, viewport.k, worldFromClient]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        clipboard.current = nodes.filter((node) => selectedIds.includes(node.id)).map((node) => ({ ...node, metadata: { ...node.metadata } }));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        if (!clipboard.current.length) return;
        pushHistory();
        const clones = clipboard.current.map((node) => ({ ...node, id: nanoid(), position: { x: node.position.x + 40, y: node.position.y + 40 }, metadata: { ...node.metadata } }));
        setNodes((prev) => [...prev, ...clones]);
        setSelectedIds(clones.map((node) => node.id));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedIds.length) {
          event.preventDefault();
          deleteNodes(selectedIds);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteNodes, nodes, pushHistory, redo, selectedIds, undo]);

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

  const nodeById = useCallback((id: string) => nodes.find((node) => node.id === id), [nodes]);
  const contextNode = contextMenu?.type === "node" ? nodeById(contextMenu.nodeId) : undefined;

  const handleTextChange = useCallback(
    (nodeId: string, content: string) => {
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, content } }));
    },
    [patchNode],
  );

  const handleConfigChange = useCallback(
    (nodeId: string, patch: Partial<CanvasGenerationConfig>) => {
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, genConfig: { ...(node.metadata?.genConfig ?? defaultConfig), ...patch } } }));
      setStoreConfig(patch);
    },
    [defaultConfig, patchNode, setStoreConfig],
  );

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

    patchNode(nodeId, (n) => ({
      ...n,
      metadata: {
        ...n.metadata,
        content: aiTextGenerated,
      },
    }));
  }, [aiTextTargetNodeId, aiTextGenerated, patchNode]);

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
      patchNode(optimizeNodeId, (node) => ({ ...node, metadata: { ...node.metadata, composerContent: optimizedText } }));
    }
    optimizeHandleRef.current = null;
    setOptimizedText("");
    setOptimizeError(null);
  }, [optimizedText, optimizeNodeId, patchNode]);

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
        backgroundMode={backgroundMode}
        onViewportChange={setViewport}
        onCanvasMouseDown={handleCanvasSelectionStart}
        onCanvasDeselect={() => { setSelectedIds([]); setContextMenu(null); if (titleDraft !== null) { renameProject(projectId, titleDraft); setTitleDraft(null); } }}
        onContextMenu={(event) => event.preventDefault()}
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
            const active = selectedIds.includes(connection.fromNodeId) || selectedIds.includes(connection.toNodeId);
            return (
              <g key={connection.id} className="pointer-events-auto">
                <ConnectionPath connection={connection} from={from} to={to} active={active} onSelect={() => undefined} onContextMenu={(event) => setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id })} />
              </g>
            );
          })}
          {connecting && <ActiveConnectionPath node={nodeById(connecting.handle.nodeId)} handle={connecting.handle} mouseWorld={connecting.mouseWorld} target={connecting.targetId ? nodeById(connecting.targetId) : undefined} />}
        </svg>

        {nodes.map((node) => {
          const referenceLimit = node.type === CanvasNodeType.Config ? getConfigReferenceLimit(node) : null;
          return (
            <CanvasNode
              key={node.id}
              data={node}
              imageUrl={nodeImageUrl(node)}
              isSelected={selectedIds.includes(node.id)}
              isRelated={relatedIds.has(node.id)}
              isConnectionTarget={connecting?.targetId === node.id}
              referenceLimitExceeded={Boolean(referenceLimit?.exceeded)}
              zIndex={nodeZIndexMap[node.id] ?? 1}
              showImageInfo={showImageInfo}
              onPointerDownNode={handleNodePointerDown}
              onSelectNode={(id) => { if (!selectedIds.includes(id)) setSelectedIds([id]); }}
              onContextMenu={(event, id) => {
                event.preventDefault();
                if (!selectedIds.includes(id)) setSelectedIds([id]);
                setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
              }}
              onConnectStart={handleConnectStart}
              onResizeStart={handleResizeStart}
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
                patchNode(nodeId, (n) => ({
                  ...n,
                  metadata: { ...n.metadata, renderMode: n.metadata?.renderMode === "markdown" ? "plain" : "markdown" },
                }));
              }}
              onAiGenerate={handleAiTextOpen}
              renderPanel={(configNode, onSelect) => (
                <CanvasConfigNodePanel
                  prompt={configNode.metadata?.composerContent || ""}
                  references={buildNodeMentionReferences(configNode, nodes, connections, imageUrls)}
                  config={configNode.metadata?.genConfig ?? defaultConfig}
                  lockResultNodes={Boolean(configNode.metadata?.lockResultNodes)}
                  referenceLimit={referenceLimit ?? getConfigReferenceLimit(configNode)}
                  busy={busyNodeIds.includes(configNode.id)}
                  optimizing={optimizing && optimizeNodeId === configNode.id}
                  onPromptChange={(value) => patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, composerContent: value } }))}
                  onConfigChange={(patch) => handleConfigChange(configNode.id, patch)}
                  onToggleLock={() => patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, lockResultNodes: !n.metadata?.lockResultNodes } }))}
                  onSelect={onSelect}
                  onOptimizePrompt={() => void handleOptimizePrompt(configNode)}
                  onGenerate={() => void runGeneration(configNode)}
                />
              )}
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
        <Button variant="outline" size="sm" onClick={onBack}>
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
      </div>

      <CanvasToolbar
        selectedCount={selectedIds.length}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        backgroundMode={backgroundMode}
        showImageInfo={showImageInfo}
        showPromptGallery={showPromptGallery}
        onAddImage={() => addNode(CanvasNodeType.Image)}
        onAddText={() => addNode(CanvasNodeType.Text)}
        onAddAnnotation={() => addNode(CanvasNodeType.TextAnnotation)}
        onAddConfig={() => addNode(CanvasNodeType.Config)}
        onImportPromptGallery={() => setPromptGalleryOpen(true)}
        onOpenTemplate={() => setTemplateOpen(true)}
        onUndo={undo}
        onRedo={redo}
        onDelete={() => deleteNodes(selectedIds)}
        onBackgroundModeChange={setBackgroundMode}
        onShowImageInfoChange={setShowImageInfo}
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
              pushHistory();
              setConnections((prev) => prev.filter((connection) => connection.id !== contextMenu.connectionId));
            }
          },
          onToggleRenderMode: contextNode?.type === CanvasNodeType.Text
            ? () => {
                patchNode(contextNode.id, (n) => ({
                  ...n,
                  metadata: { ...n.metadata, renderMode: n.metadata?.renderMode === "markdown" ? "plain" : "markdown" },
                }));
              }
            : undefined,
          onAnnotationChangeColor: contextNode?.type === CanvasNodeType.TextAnnotation
            ? () => {
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
