import type { AspectRatio, OutputSize } from '@/lib/gemini-config';
import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import {
  getCompleteImageModels,
  getCompleteTextModels,
  getImageModelById,
  getTextModelById,
  loadRegistry,
  type ProviderProtocol,
} from '@/lib/nova-models';
import {
  normalizeModelBaseUrl,
  normalizeTextModelBaseUrl,
} from '@/lib/model-endpoints';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

export interface ImageReference {
  data: string;
  mimeType: string;
}

export interface ModelStatus {
  modelId: string;
  available: boolean;
  actualName?: string;
  message?: string;
}

const MODEL_CHECK_TIMEOUT = 30000;
const TASK_REQUEST_TIMEOUT = 30000;
const CREATE_TASK_TIMEOUT = 60000;

export type NovaTaskMode = 'text-to-image' | 'image-to-image';
export type NovaTaskStatus = 'queued' | '排队中' | 'processing' | 'completed' | 'failed' | 'expired';

export interface CreateNovaTaskInput {
  apiKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  mode: NovaTaskMode;
  prompt: string;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  model: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  parallelCount: number;
  images: ImageReference[];
}

export interface NovaTaskResponse {
  id: string;
  status: NovaTaskStatus;
  mode?: NovaTaskMode;
  result?: { images?: string[] };
  error?: string;
  warning?: string;
  createdAt?: string;
  completedAt?: string;
  expiresAt?: string;
}

export interface NovaQueueStatus {
  concurrencyLimit: number;
  configuredConcurrency: number;
  processingCount: number;
  queuedCount: number;
  pendingCount?: number;
  maxQueueSize?: number;
  remainingQueueSlots?: number;
  displayConcurrency: number;
  displayQueued: number;
  acceptingNewTasks: boolean;
  rateLimitWindowMs?: number;
  rateLimitMaxRequestsPerIp?: number;
  rateLimitMaxRequestsPerApiKey?: number;
  retryAfterSeconds?: number;
  serverMessage?: string;
}

export class NovaTaskError extends Error {
  statusCode: number;
  code?: string;
  retryAfter?: number;

  constructor(message: string, statusCode: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'NovaTaskError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface CreateTaskResponse {
  taskId?: string;
}

function getObjectProperty(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null && key in data
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

async function parseTaskResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = getObjectProperty(data, 'error');
    const code = getObjectProperty(data, 'code');
    const retryAfter = getObjectProperty(data, 'retryAfter');
    throw new NovaTaskError(
      typeof error === 'string' ? error : `任务请求失败: ${response.status}`,
      response.status,
      typeof code === 'string' ? code : undefined,
      typeof retryAfter === 'number' ? retryAfter : undefined,
    );
  }
  return data as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function normalizeModelCheckError(error: unknown): Error {
  const errorMessage = getErrorMessage(error);
  const lowerMessage = errorMessage.toLowerCase();

  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('abort') ||
    lowerMessage.includes('请求超时')
  ) {
    return new Error('模型检查超时，请稍后重试。');
  }

  if (
    lowerMessage.includes('failed to fetch') ||
    lowerMessage.includes('fetch failed') ||
    lowerMessage.includes('networkerror') ||
    lowerMessage.includes('network request failed') ||
    lowerMessage.includes('load failed') ||
    lowerMessage.includes('network connection was lost') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('terminated')
  ) {
    return new Error('网络连接失败。请检查网络连接或稍后重试。');
  }

  return error instanceof Error ? error : new Error(errorMessage);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = MODEL_CHECK_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createNovaTask(input: CreateNovaTaskInput): Promise<string> {
  const response = await fetchWithTimeout('/api/nova/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, CREATE_TASK_TIMEOUT);
  const data = await parseTaskResponse<CreateTaskResponse>(response);
  if (!data?.taskId) throw new Error('创建任务失败：后端未返回任务 ID');
  return data.taskId;
}

export async function checkModelsAvailability(
  targetModelIds?: string[],
): Promise<ModelStatus[]> {
  try {
    const registry = loadRegistry();
    const completeImageModels = getCompleteImageModels(registry);
    const completeTextModels = getCompleteTextModels(registry);
    const configuredModels = [
      ...completeImageModels.map((model) => ({
        id: model.id,
        name: model.name,
        protocol: model.protocol,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelId: model.modelId,
      })),
      ...completeTextModels.map((model) => ({
        id: model.id,
        name: model.name,
        protocol: model.protocol,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelId: model.modelId,
      })),
    ];

    const filteredModels = targetModelIds && targetModelIds.length > 0
      ? configuredModels.filter((model) => targetModelIds.includes(model.id))
      : configuredModels;

    if (filteredModels.length === 0) {
      return [];
    }

    return Promise.all(filteredModels.map(async (model) => {
      try {
        const normalizedBaseUrl = completeImageModels.some(imageModel => imageModel.id === model.id)
          ? normalizeModelBaseUrl(model.protocol as ProviderProtocol, model.baseUrl)
          : normalizeTextModelBaseUrl(model.protocol as TextProviderProtocol, model.baseUrl);
        if (!normalizedBaseUrl || !model.apiKey || !model.modelId) {
          return {
            modelId: model.id,
            actualName: model.name,
            available: false,
            message: '模型配置不完整',
          };
        }

        // 统一通过后端代理使用 /v1/models（NewAPI 兼容）
        const proxyUrl = `/api/nova/proxy/models?baseUrl=${encodeURIComponent(normalizedBaseUrl)}&apiKey=${encodeURIComponent(model.apiKey)}&protocol=${model.protocol}`;
        const response = await fetch(proxyUrl, { method: 'GET', cache: 'no-store' });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          return {
            modelId: model.id,
            actualName: model.name,
            available: false,
            message: `${response.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`,
          };
        }
        const data = await response.json().catch(() => ({})) as {
          data?: Array<{ id?: string; model?: string }>;
          models?: Array<{ name?: string }>;
        };
        const exists = (
          (Array.isArray(data.data) && data.data.some(
            (item) => String(item?.id || item?.model || '') === model.modelId,
          ))
          || (Array.isArray(data.models) && data.models.some(
            (item) => String(item?.name || '').replace(/^models\//, '') === model.modelId,
          ))
        );
        return {
          modelId: model.id,
          actualName: model.name,
          available: exists,
          message: exists ? model.modelId : `未在 /models 中找到 ${model.modelId}`,
        };
      } catch (error) {
        return {
          modelId: model.id,
          actualName: model.name,
          available: false,
          message: getErrorMessage(error),
        };
      }
    }));
  } catch (error) {
    throw normalizeModelCheckError(error);
  }
}

export function resolveImageTaskProvider(modelId: string): { apiKey: string; baseUrl: string; protocol: ProviderProtocol; modelId: string } {
  const registry = loadRegistry();
  const model = getImageModelById(registry, modelId);
  if (!model) throw new Error(`未找到图片模型配置: ${modelId}`);
  const normalizedBaseUrl = normalizeModelBaseUrl(model.protocol, model.baseUrl);
  return {
    apiKey: model.apiKey,
    baseUrl: normalizedBaseUrl,
    protocol: model.protocol,
    modelId: model.modelId,
  };
}

export function resolveTextTaskProvider(modelId: string): { apiKey: string; baseUrl: string; protocol: TextProviderProtocol } {
  const registry = loadRegistry();
  const model = getTextModelById(registry, modelId);
  if (!model) throw new Error(`未找到文本模型配置: ${modelId}`);
  const normalizedBaseUrl = normalizeTextModelBaseUrl(model.protocol, model.baseUrl);
  return {
    apiKey: model.apiKey,
    baseUrl: normalizedBaseUrl,
    protocol: model.protocol,
  };
}

export async function getNovaTask(taskId: string): Promise<NovaTaskResponse> {
  const response = await fetchWithTimeout(`/api/nova/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    cache: 'no-store',
  }, TASK_REQUEST_TIMEOUT);
  return parseTaskResponse(response);
}

export async function getNovaQueueStatus(): Promise<NovaQueueStatus> {
  const response = await fetchWithTimeout('/api/nova/queue-status', {
    method: 'GET',
    cache: 'no-store',
  }, TASK_REQUEST_TIMEOUT);
  return parseTaskResponse(response);
}

export async function ackNovaTask(taskId: string): Promise<void> {
  await fetch(`/api/nova/tasks/${encodeURIComponent(taskId)}/ack`, {
    method: 'POST',
  }).catch(() => undefined);
}

// ===== 向后兼容别名 =====
/** @deprecated Use NovaTaskMode */
export type CcodeTaskMode = NovaTaskMode;
/** @deprecated Use NovaTaskStatus */
export type CcodeTaskStatus = NovaTaskStatus;
/** @deprecated Use CreateNovaTaskInput */
export type CreateCcodeTaskInput = CreateNovaTaskInput;
/** @deprecated Use NovaTaskResponse */
export type CcodeTaskResponse = NovaTaskResponse;
/** @deprecated Use NovaQueueStatus */
export type CcodeQueueStatus = NovaQueueStatus;
/** @deprecated Use NovaTaskError */
export const CcodeTaskError = NovaTaskError;
/** @deprecated Use createNovaTask */
export const createCcodeTask = createNovaTask;
/** @deprecated Use checkModelsAvailability */
export const checkCcodeModelsAvailability = checkModelsAvailability;
/** @deprecated Use getNovaTask */
export const getCcodeTask = getNovaTask;
/** @deprecated Use getNovaQueueStatus */
export const getCcodeQueueStatus = getNovaQueueStatus;
/** @deprecated Use ackNovaTask */
export const ackCcodeTask = ackNovaTask;
