// 提示词优化流式客户端
// 统一通过 /api/nova/proxy/text 按文本协议转发。

import { getConfiguredTextModel } from '@/lib/model-endpoints';
import {
  buildSimpleProxyTextRequestBody,
  handleSimpleTextStreamEvent,
} from '@/lib/nova-proxy-text';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import { readSseStream } from '@/lib/sse-stream-parser';

const OPTIMIZE_MODEL = 'gpt-5.4-mini';
const OPTIMIZE_TIMEOUT_MS = 30_000;
const OPTIMIZE_MAX_ATTEMPTS = 2;

export type PromptOptimizeMode = 'text-to-image' | 'image-to-image' | 'gif' | 'agent' | 'canvas-prompt-gallery-import' | 'canvas-prompt-gallery-config';

export interface OptimizeImageInput {
  dataUrl: string;
  mimeType: string;
}

export interface StreamPromptOptimizeInput {
  apiKey: string;
  model?: string;
  mode: PromptOptimizeMode;
  prompt: string;
  images?: OptimizeImageInput[];
  context?: string;
}

export interface StreamPromptOptimizeCallbacks {
  onDelta(token: string): void;
  onDone(fullText: string): void;
  onError(err: Error): void;
}

export interface StreamPromptOptimizeHandle {
  abort(): void;
  promise: Promise<void>;
}

const SYSTEM_PROMPTS: Record<PromptOptimizeMode, string> = {
  'text-to-image': `你是一位专业的 AI 绘图提示词优化专家。
你的任务是将用户的简短描述优化为高质量的文生图提示词。
优化规则：
- 保留用户的原始意图和核心描述
- 补充画面主体的细节（外观、材质、姿态等）
- 添加合适的艺术风格描述（如摄影、插画、油画等）
- 补充光影、色调、氛围描述
- 优化构图和视角描述
- 使用简洁精准的中文描述
- 不要添加与画面无关的说明文字
只输出优化后的提示词本身，不要输出任何解释、前缀或额外说明。`,
  'image-to-image': `你是一位专业的图生图提示词优化专家。
你的任务是结合参考图和用户描述，优化为精准的图生图提示词。
优化规则：
- 观察参考图的内容、风格、色调、构图
- 结合用户的修改意图，生成精准的图生图提示词
- 保留用户想要保留的参考图元素
- 明确描述用户想要修改的部分
- 使用简洁精准的中文描述
- 不要添加与画面无关的说明文字
只输出优化后的提示词本身，不要输出任何解释、前缀或额外说明。`,
  gif: `你是一位专业的动图生成提示词优化专家。
你的任务是结合参考图和用户描述，优化为适合生成 3×4 = 12 帧网格动画的提示词。
优化规则：
- 观察参考图（如有）的内容、风格、色调
- 描述必须适合 1:1 正方形帧构图
- 强调动作的连续性和逐帧变化，确保 12 帧之间动作流畅衔接
- 描述一个完整、有节奏的动作过程（如眨眼、点头、转身等）
- 动作幅度适中，适合在 12 帧内完成一个循环
- 如有首尾帧闭合需求，确保第 12 帧自然过渡回第 1 帧
- 使用简洁精准的中文描述
- 不要添加与画面无关的说明文字
只输出优化后的提示词本身，不要输出任何解释、前缀或额外说明。`,
  agent: `你是一位描述润色助手。
你的任务是优化用户的自然语言描述，使其更加清晰、准确和详细。
优化规则：
- 修正语病和错别字
- 增强表达的清晰度和逻辑性
- 补充必要的细节描述，使意图更加明确
- 保持用户原始意图不变，不要改变其核心需求
- 保持自然口语化风格，不要过度书面化
我们会提供一段对话上下文供你参考（包含最近的聊天记录和图片描述），让你了解用户当前在做什么。
但上下文仅是参考，不要被其束缚——你的主要任务仍是优化用户输入的那段文本。
只输出优化后的描述文本，不要输出任何解释、前缀或额外说明。`,
  'canvas-prompt-gallery-import': `你是一位无限画布提示词适配专家。
用户会从提示词广场导入模板提示词，画布会额外提供参考图节点、用户上传的目标角色/OC图节点和生成配置说明。
你的任务是把提示词广场原文改写为适合该画布流程使用的参考提示词。
改写规则：
- 移除或改写所有依赖具体图片编号的表达，例如“图1”“图2”“第一张图”“第二张图”“image 1”“image 2”。
- 将编号绑定的角色替换关系改成“模板参考图中的角色占位由用户上传角色/OC特征替换”。
- 明确用户上传角色/OC是唯一角色身份来源，模板参考图只提供姿势、动作、构图、背景、光影、风格和行为。
- 保留原提示词里的关键画面要求、姿势、动作、风格、构图、道具和限制条件。
- 削弱或移除模板参考图自身人物身份、五官、发型、服装、配饰等会与用户上传角色冲突的描述。
- 不要让多张模板参考图互相模仿、互相替换或混合身份。
- 不要描述图片输入顺序，画布生成配置会负责指定参考图和用户上传图。
- 使用简洁精准的中文。
只输出改写后的提示词本身，不要输出解释、前缀、编号或额外说明。`,
  'canvas-prompt-gallery-config': `你是一位无限画布配置节点提示词优化专家。
用户正在把提示词广场模板套用到自己上传的目标角色/OC图上。模板参考图不会提供给你，避免你把模板图内容误解成角色身份；你最多只会收到用户上传的目标角色/OC图。
你的任务是优化配置节点提示词，让后续生图模型更稳定地参考用户上传图片完成角色替换。
优化规则：
- 必须保留所有 @[node:...] 节点引用 token，不能删除、改写、重排或新造 token。
- 不要用文字描述用户上传图片里的具体外貌、发型、服装、配饰、颜色或身份细节；生图模型会直接读取图片，文字复述反而会干扰。
- 用“目标角色图”“用户上传角色图”“参考目标角色图”这类指代强调角色身份来源，而不是把图片内容展开成文字。
- 如果没有收到目标角色/OC图，也不要根据模板参考图或提示词猜测角色外观，只保留目标角色图引用和等待图片输入的语义。
- 明确模板参考图只提供姿势、手势、口型、构图、背景、光影、风格和行为，最终角色身份以用户上传角色图为准。
- 保留原提示词中的画面结构、动作、风格、构图、道具和限制条件。
- 不要让模板参考图之间互相模仿、互相替换或混合人物身份。
- 使用简洁精准的中文。
只输出改写后的提示词本身，不要输出解释、前缀、编号或额外说明。`,
};

export function streamPromptOptimize(
  input: StreamPromptOptimizeInput,
  callbacks: StreamPromptOptimizeCallbacks,
  baseUrl: string = '',
): StreamPromptOptimizeHandle {
  const controller = new AbortController();

  const promise = (async () => {
    try {
      await runWithRetry(baseUrl, input, callbacks, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      callbacks.onError(normalizeError(err));
    }
  })();

  return {
    abort: () => controller.abort(),
    promise,
  };
}

async function runWithRetry(
  baseUrl: string,
  input: StreamPromptOptimizeInput,
  callbacks: StreamPromptOptimizeCallbacks,
  controller: AbortController,
): Promise<void> {
  const signal = controller.signal;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= OPTIMIZE_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) return;
    try {
      await runAttempt(baseUrl, input, callbacks, controller);
      return;
    } catch (err) {
      if (signal.aborted) return;
      const normalized = normalizeError(err);
      lastError = normalized;
      if (attempt >= OPTIMIZE_MAX_ATTEMPTS || !isRetryable(err)) {
        throw normalized;
      }
    }
  }
  throw lastError || new Error('优化请求失败');
}

async function runAttempt(
  baseUrl: string,
  input: StreamPromptOptimizeInput,
  callbacks: StreamPromptOptimizeCallbacks,
  controller: AbortController,
): Promise<void> {
  const configured = getConfiguredTextModel(input.model || '');
  const protocol = (configured?.protocol || 'openai-responses') as TextProviderProtocol;
  const actualModel = configured?.modelId || input.model || OPTIMIZE_MODEL;
  const actualBaseUrl = configured?.baseUrl || baseUrl;
  const signal = controller.signal;

  let userText = `${SYSTEM_PROMPTS[input.mode]}\n\n---\n\n`;
  if (input.context) {
    userText += `${input.context}\n\n---\n\n`;
  }
  userText += `用户输入：\n${input.prompt}`;

  const parts = [
    { type: 'text' as const, text: userText },
    ...((input.images || []).map(image => ({ type: 'image' as const, imageDataUrl: image.dataUrl, mimeType: image.mimeType }))),
  ];

  const body = buildSimpleProxyTextRequestBody(
    protocol,
    actualModel,
    parts,
    { stream: true, reasoningEffort: 'low' }
  );

  const timeoutId = window.setTimeout(() => {
    if (!signal.aborted) {
      controller.abort(new DOMException('优化请求超时', 'TimeoutError'));
    }
  }, OPTIMIZE_TIMEOUT_MS);

  try {
    const response = await fetch('/api/nova/proxy/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol,
        baseUrl: actualBaseUrl,
        apiKey: input.apiKey,
        model: actualModel,
        stream: true,
        requestBody: body,
      }),
      signal,
    });

    if (!response.ok) {
      throw await readHttpError(response);
    }
    if (!response.body) {
      throw new Error('响应没有可读流');
    }

    let accumulated = '';
    let fired = false;

    const fireDone = () => {
      if (fired) return;
      fired = true;
      callbacks.onDone(accumulated);
    };

    await readSseStream(response.body, signal, (event) => {
      if (!event.data) return;
      if (event.data === '[DONE]') {
        fireDone();
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      accumulated = handleSimpleTextStreamEvent(protocol, payload, event.event || '', accumulated, callbacks.onDelta, fireDone);
    });

    fireDone();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readHttpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    // ignore
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail);
      const message = parsed?.error?.message || parsed?.error || parsed?.message;
      if (typeof message === 'string' && message.length > 0) {
        return new Error(`${response.status} ${response.statusText}: ${message}`);
      }
    } catch {
      // not JSON
    }
  }
  return new Error(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return [
    '408', '429', '500', '502', '503', '504',
    'failed to fetch', 'network', 'load failed',
    'timeout', 'timed out',
  ].some(keyword => lower.includes(keyword));
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      lower.includes('failed to fetch')
      || lower.includes('network')
      || lower.includes('load failed')
    ) {
      return new Error('网络连接失败，请检查网络后重试');
    }
    return error;
  }
  return new Error(String(error));
}
