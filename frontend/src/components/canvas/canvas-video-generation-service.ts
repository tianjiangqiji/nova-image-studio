"use client";

/**
 * 画布视频生成服务——把画布节点输入（提示词、画布图片引用、内存音视频素材）
 * 上传后提交到【插件任务端点】，并轮询到终态。
 *
 * 这里没有任何具体视频上游的知识：插件选择、参数校验、素材槽名额全部由
 * 插件的 ui.schema 驱动（frontend/src/lib/plugin-schema.ts），提交走宿主
 * /api/nova/plugin-tasks。管理员换一个视频插件，画布无需改动。
 */

import {
  createPluginTask,
  getPluginTask,
  ackPluginTask,
  uploadPluginMedia,
  type PluginAsset,
  type PluginTaskResponse,
} from "@/lib/plugin-task-client";
import { getPluginCredential } from "@/lib/plugin-registry-client";
import {
  buildScope,
  isFieldVisible,
  resolveModel,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
  type MediaKind,
  type PluginField,
} from "@/lib/plugin-schema";
import { CanvasApiKeyMissingError } from "./canvas-generation-service";
import { imageToDataUrl } from "./lib/image-storage";
import { initUploadProgress, updateUploadProgress } from "./lib/canvas-video-upload-store";
import type { ReferenceImage } from "./types-media";

/** 插件凭据缺失（未在设置里配置该插件的 API Key）。复用图片模式的「需要密钥」回调通道。 */
export class CanvasVideoCredentialMissingError extends CanvasApiKeyMissingError {
  constructor(pluginName: string) {
    super();
    this.message = `请先在设置中配置「${pluginName}」的 API 密钥`;
    this.name = "CanvasVideoCredentialMissingError";
  }
}

/** 一个待上传素材：本地文件，或画布图片节点引用（上传前解析为 File）。 */
export type CanvasVideoMediaItem = {
  id: string;
  name: string;
  kind: MediaKind;
  /** 画布图片节点引用（生成时从 storageKey/dataUrl 解析为 File 上传） */
  referenceImage?: ReferenceImage;
  /** 内存文件（音/视频/上传的帧） */
  file?: File;
};

export type CanvasVideoTaskProgress = {
  status: "queued" | "processing" | "completed" | "failed" | "expired";
  /** 上游真实进度（0-100）；上游未返回时为 undefined，调用方不得用时间估算顶替 */
  progress?: number;
  upstreamStatus?: "queued" | "processing" | "completed" | "failed";
  error?: string;
};

export type CanvasVideoGenerationResult = {
  videoUrl: string;
  posterUrl?: string;
  durationSec?: number;
};

const POLL_INTERVAL = 2500;
const MAX_WAIT_MS = 30 * 60 * 1000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** 主提示词字段约定（与宿主 PluginWorkbench 相同）：第一个 textarea 绑定画布提示词。 */
export function findCanvasPromptField(plugin: InstalledPlugin): PluginField | undefined {
  return plugin.uiSchema.fields.find(field => field.type === "textarea");
}

/** 当前 facet/字段组合下要显示且有名次的素材槽。 */
export function visibleCanvasMediaFields(
  plugin: InstalledPlugin,
  facets: FacetValues,
  fields: FieldValues,
): { field: PluginField; maxCount: number }[] {
  const schema = plugin.uiSchema;
  const scope = buildScope(facets, fields);
  const result: { field: PluginField; maxCount: number }[] = [];
  for (const field of schema.fields) {
    if (field.type !== "media") continue;
    if (!isFieldVisible(field, scope)) continue;
    // maxCount 求解逻辑与 plugin-schema.resolveMaxCount 一致；这里不复用导出是为了
    // 同时拿到 field 引用（该函数只回数字）。规则：数字直取；对象按 facet 取值。
    const max = field.maxCount;
    let count = 0;
    if (typeof max === "number") count = Number.isInteger(max) ? max : 0;
    else if (max && typeof max === "object") {
      const value = max.values[String(facets[max.byFacet])];
      count = Number.isInteger(value) ? value : Number.isInteger(max.default) ? (max.default as number) : 0;
    }
    if (count > 0) result.push({ field, maxCount: count });
  }
  return result;
}

/**
 * 上传全部素材并创建插件任务，返回 taskId。
 * 上传进度写入 canvas-video-upload-store（键 = resultNodeId）。
 */
export async function submitCanvasVideoGeneration(args: {
  resultNodeId: string;
  plugin: InstalledPlugin;
  prompt: string;
  facets: FacetValues;
  fields: FieldValues;
  /** 素材槽 key → 该槽的素材（有序）。槽 key 必须在 visibleCanvasMediaFields 里。 */
  mediaSlots: Record<string, CanvasVideoMediaItem[]>;
  signal?: AbortSignal;
}): Promise<string> {
  const credential = getPluginCredential(args.plugin);
  if (!credential.apiKey) throw new CanvasVideoCredentialMissingError(args.plugin.name);
  throwIfAborted(args.signal);

  const schema = args.plugin.uiSchema;
  const model = resolveModel(schema, args.facets);
  if (!model) throw new Error("当前参数组合没有对应的模型");

  // 第一个 textarea 字段绑定画布提示词（面板不单独渲染它）
  const promptField = findCanvasPromptField(args.plugin);
  const fields: FieldValues = { ...args.fields };
  if (promptField) fields[promptField.key] = args.prompt;

  const flatItems = Object.entries(args.mediaSlots).flatMap(([, items]) => items);
  initUploadProgress(
    args.resultNodeId,
    flatItems.map(item => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      // 画布图片引用在上传前不知大小：bytes=0 时进度条不显示百分比，只随状态走
      bytes: item.file?.size ?? 0,
      loaded: 0,
      status: "pending" as const,
    })),
  );

  const media: Record<string, string[]> = {};
  // 顺序逐个上传，不并发：一次拖多个素材并发上传会打满后端的素材限流（与宿主 runner 同理）
  for (const [slotKey, items] of Object.entries(args.mediaSlots)) {
    media[slotKey] = [];
    for (const item of items) {
      throwIfAborted(args.signal);
      const file = await resolveMediaFile(item);
      updateUploadProgress(args.resultNodeId, item.id, { status: "uploading" });
      let uploaded: { url: string };
      try {
        uploaded = await uploadPluginMedia(args.plugin.id, file, item.kind, {
          onProgress: loaded => updateUploadProgress(args.resultNodeId, item.id, { loaded }),
          signal: args.signal,
        });
      } catch (error) {
        // 用户取消不是失败：条目留在当前状态，由调用方决定清理或复位
        if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const message = error instanceof Error ? error.message : String(error);
        updateUploadProgress(args.resultNodeId, item.id, { status: "failed", error: message });
        throw new Error(`素材「${item.name}」上传失败：${message}`);
      }
      updateUploadProgress(args.resultNodeId, item.id, { status: "done", loaded: item.file?.size ?? 0 });
      media[slotKey].push(uploaded.url);
    }
  }
  // 没有条目的槽保留空数组：后端按 key 找字段，缺 key 可能被当作未提供
  for (const { field } of visibleCanvasMediaFields(args.plugin, args.facets, fields)) {
    if (!media[field.key]) media[field.key] = [];
  }

  // 上传成功后不 clearUploadProgress：保留 done 条目，让总进度从上传段平滑过渡到生成段
  throwIfAborted(args.signal);
  return createPluginTask({
    pluginId: args.plugin.id,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
    model,
    facets: args.facets,
    fields,
    media,
  });
}

/** 轮询插件任务直到终态；onProgress 实时回调状态与上游进度。 */
export async function pollCanvasVideoTask(
  taskId: string,
  onProgress: (progress: CanvasVideoTaskProgress) => void,
  signal?: AbortSignal,
): Promise<CanvasVideoGenerationResult> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    throwIfAborted(signal);
    const task = await getPluginTask(taskId);
    // 拿到响应后、回调调用方前再查一次取消：取消后不再通知，也不再走终态分支
    throwIfAborted(signal);
    const progress = toTaskProgress(task);
    onProgress(progress);
    if (task.status === "completed") {
      const result = extractVideoAsset(task.result?.assets);
      if (!result) throw new Error("生成完成但未返回视频地址");
      void ackPluginTask(taskId);
      return result;
    }
    if (task.status === "failed" || task.status === "expired") {
      void ackPluginTask(taskId);
      throw new Error(task.error || (task.status === "expired" ? "该任务已超出取回时间" : "生成失败"));
    }
    if (Date.now() > deadline) throw new Error("生成超时，请稍后重试");
    await delay(POLL_INTERVAL, signal);
  }
}

/** 查询已有任务当前状态（用于刷新恢复与手动获取进度）。终态时附带 result。 */
export async function checkExistingVideoTask(taskId: string): Promise<CanvasVideoTaskProgress & { result?: CanvasVideoGenerationResult }> {
  const task = await getPluginTask(taskId);
  if (task.status === "completed") {
    const result = extractVideoAsset(task.result?.assets);
    if (result) {
      void ackPluginTask(taskId);
      return { ...toTaskProgress(task), result };
    }
    return { ...toTaskProgress(task), error: "生成完成但未返回视频地址" };
  }
  if (task.status === "failed" || task.status === "expired") {
    void ackPluginTask(taskId);
    return { ...toTaskProgress(task), error: task.error || (task.status === "expired" ? "该任务已超出取回时间" : "生成失败") };
  }
  return toTaskProgress(task);
}

/** PluginTaskResponse → 对外进度：「排队中」（本机队列）与 queued 同义；上游未返回的字段不占位。 */
function toTaskProgress(task: PluginTaskResponse): CanvasVideoTaskProgress {
  const progress: CanvasVideoTaskProgress = {
    status: task.status === "queued" || task.status === "排队中" ? "queued" : task.status,
  };
  if (task.progress !== undefined) progress.progress = task.progress;
  if (task.upstreamStatus !== undefined) progress.upstreamStatus = task.upstreamStatus;
  if (task.error !== undefined) progress.error = task.error;
  return progress;
}

/** 从产物列表里找视频：插件声明 outputs 含 video，宿主归一化后的 kind 就是 "video"。 */
function extractVideoAsset(assets: PluginAsset[] | undefined): CanvasVideoGenerationResult | null {
  const asset = assets?.find(item => item.kind === "video");
  if (!asset?.url) return null;
  return { videoUrl: asset.url, posterUrl: asset.posterUrl, durationSec: asset.durationSec };
}

/** 画布图片引用 → File：先经 imageToDataUrl 统一取 dataUrl（storageKey/dataUrl/blob: 均有兜底），再 fetch 回 blob。 */
async function resolveMediaFile(item: CanvasVideoMediaItem): Promise<File> {
  if (item.file) return item.file;
  const ref = item.referenceImage;
  if (!ref) throw new Error(`素材「${item.name}」缺少可上传的文件`);
  const dataUrl = await imageToDataUrl(ref);
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], item.name, { type: blob.type || ref.type });
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
  });
}
