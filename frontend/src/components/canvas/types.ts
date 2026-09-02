import type { AspectRatio, OutputSize } from "@/lib/gemini-config";
import type { GptImageBackground, GptImageQuality, GptImageStyle, ParallelCount } from "@/lib/model-capabilities";
import type { FacetValues, FieldValues } from "@/lib/plugin-schema";

export type Position = {
  x: number;
  y: number;
};

export type ViewportTransform = {
  x: number;
  y: number;
  k: number;
};

export enum CanvasNodeType {
  Image = "image",
  Video = "video",
  Audio = "audio",
  Text = "text",
  Config = "config",
  TextAnnotation = "textAnnotation",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "uploading" | "submitting" | "queued" | "processing" | "error";
export type CanvasInteractionMode = "select" | "pan";
/** 生成模式：图像走宿主任务队列；视频走插件任务链路（素材上传 + 插件任务轮询），由已安装的视频插件驱动。 */
export type CanvasGenerationMode = "image" | "video";
export type CanvasImageGenerationType = "generation" | "edit";

/** 单个配置/编排节点的生成参数（写在节点上）。 */
export type CanvasGenerationConfig = {
  model: string;
  outputSize: OutputSize;
  aspectRatio: AspectRatio;
  customSize?: string;
  temperature: number;
  count: ParallelCount;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
};

export type CanvasPromptRouteSelection =
  | { mode: "manual" }
  | { mode: "route"; connectionIds: string[] };

export type CanvasNodeMetadata = {
  content?: string;
  composerContent?: string;
  prompt?: string;
  status?: CanvasNodeStatus;
  errorDetails?: string;
  fontSize?: number;
  generationMode?: CanvasGenerationMode;
  generationType?: CanvasImageGenerationType;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  references?: string[];
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  batchUsesReferenceImages?: boolean;
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  /** 生成结果是否已经持久化到本地图片存储。 */
  resultCacheStatus?: "pending" | "cached" | "failed";
  /** 本地缓存失败时保留的后端图片地址。 */
  resultRemoteUrl?: string;
  /** 最近一次缓存失败原因。 */
  resultCacheError?: string;
  /** 配置节点的逐节点生成参数 */
  genConfig?: CanvasGenerationConfig;
  /** 配置节点：锁定结果节点模式 */
  lockResultNodes?: boolean;
  /** 配置节点：手动编排或绑定的上游提示词路线 */
  promptRouteSelection?: CanvasPromptRouteSelection;
  /** 单节点生成任务 ID（用于轮询 + 刷新恢复） */
  generationTaskId?: string;
  /** 单节点生成开始时间戳（用于计算用时） */
  generationStartedAt?: number;
  /** Video: 上游产物直链（通常数小时后过期；仅存 URL 随画布持久化，文件本体不入本地存储） */
  videoUrl?: string;
  /** Video: 封面图直链 */
  videoPosterUrl?: string;
  /** Video: 视频时长（秒） */
  videoDurationSec?: number;
  /** Video: 上游真实进度（0-100；上游未返回时不写，不用时间估算顶替） */
  videoProgress?: number;
  /** Video: 上游归一化状态 */
  videoUpstreamStatus?: "queued" | "processing" | "completed" | "failed";
  /** Video/Audio 素材节点：本地上传的原始文件名（storageKey 指向 media-storage 里的文件） */
  mediaName?: string;
  /** Video/Audio 素材节点：本地文件时长（秒） */
  mediaDurationSec?: number;
  /** Config(视频模式): 选用的视频插件 ID；参数全由插件 ui.schema 驱动 */
  videoPluginId?: string;
  /** Config(视频模式): 插件 facet 取值（档位/分辨率等，可序列化随画布持久化） */
  videoFacets?: FacetValues;
  /** Config(视频模式): 插件字段取值（模式/时长/宽高比等） */
  videoFields?: FieldValues;
  /** Config(视频模式): 帧素材槽 key → 引用的画布图片节点 ID（首帧/尾帧等 frame 样式槽位） */
  videoFrameRefs?: Record<string, string>;
  /** Config(视频模式): 视频/音频素材槽 key → 引用的画布视频/音频节点 ID（有序，可多个） */
  videoMediaRefs?: Record<string, string[]>;
  /** 画布导入流程中的节点角色，用于空目标图节点也能被编排节点 @ 引用。 */
  canvasRole?: "reference" | "target" | "reference-prompt";
  /** Text 节点：渲染模式 */
  renderMode?: "plain" | "markdown";
  /** Text 节点：是否启用 AI 生成 */
  aiGenerationEnabled?: boolean;
  /** Text 节点：AI 生成流式预览内容 */
  streamPreview?: string;
  /** Text 节点：是否正在流式生成中 */
  isStreaming?: boolean;
  /** TextAnnotation 节点：背景色 */
  backgroundColor?: string;
  /** TextAnnotation 节点：文字颜色 */
  textColor?: string;
};

export type CanvasNodeData = {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: Position;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

export type ConnectionHandle = {
  nodeId: string;
  handleType: "source" | "target";
};

export type SelectionBox = {
  startWorldX: number;
  startWorldY: number;
  currentWorldX: number;
  currentWorldY: number;
  additive: boolean;
  initialSelectedNodeIds: string[];
};

export type ContextMenuState =
  | {
      type: "canvas";
      x: number;
      y: number;
      position: Position;
    }
  | {
      type: "connection-create";
      x: number;
      y: number;
      position: Position;
      sourceNodeId: string;
      handleType: "source" | "target";
    }
  | {
      type: "node";
      x: number;
      y: number;
      nodeId: string;
    }
  | {
      type: "connection";
      x: number;
      y: number;
      connectionId: string;
    };
