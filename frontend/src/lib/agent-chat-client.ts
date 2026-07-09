// Agent 模式的浏览器直连客户端
// 文本对话与视觉描述统一通过 /api/nova/proxy/text，按文本协议动态转发。

import {
  AGENT_TEXT_MODEL_FALLBACK,
  AGENT_SYSTEM_INSTRUCTIONS,
  AGENT_IMAGE_DESCRIBE_PROMPT,
  PROPOSE_IMAGE_ACTION_TOOL,
  type AgentMessage,
  type AgentProposal,
  type AgentActionType,
} from '@/lib/agent-chat-config';
import {
  normalizeGptImageBackground,
  normalizeGptImageQuality,
  normalizeGptImageStyle,
  type AgentModelCatalogEntry,
} from '@/lib/model-capabilities';
import {
  buildSimpleProxyTextRequestBody,
  extractTextOutput,
} from '@/lib/nova-proxy-text';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import { readSseStream } from '@/lib/sse-stream-parser';

const AGENT_GPT_REQUEST_MAX_ATTEMPTS = 3;
const AGENT_CHAT_ATTEMPT_TIMEOUT_MS = 45_000;
const AGENT_IMAGE_DESCRIBE_ATTEMPT_TIMEOUT_MS = 20_000;

class AgentRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应`);
    this.name = 'AgentRequestTimeoutError';
  }
}

export interface AgentCatalogEntry {
  imgId: string;
  description: string;
}

export interface StreamAgentInput {
  apiKey: string;
  model: string;
  protocol: TextProviderProtocol;
  history: AgentMessage[];
  catalog: AgentCatalogEntry[];
  modelCatalog: AgentModelCatalogEntry[];
  webSearch?: boolean;
}

export interface StreamAgentCallbacks {
  onDelta(token: string): void;
  onReasoning(token: string): void;
  onDone(fullText: string, proposal: AgentProposal | null): void;
  onRetry?(attempt: number, maxAttempts: number, err: Error): void;
  onResetAttempt?(): void;
  onError(err: Error): void;
}

export interface StreamAgentHandle {
  abort(): void;
  promise: Promise<void>;
}

function buildInstructions(catalog: AgentCatalogEntry[], modelCatalog: AgentModelCatalogEntry[]): string {
  let instructions = AGENT_SYSTEM_INSTRUCTIONS;

  if (modelCatalog.length > 0) {
    const modelLines = modelCatalog
      .map(m => `- id: ${m.id}, 名称: "${m.name}", 最大分辨率: ${m.maxOutputSize}`)
      .join('\n');
    instructions += `\n\n当前可用图像模型：\n${modelLines}`;
  } else {
    instructions += '\n\n当前可用图像模型：（空，请在设置中配置）';
  }

  if (catalog.length === 0) {
    instructions += '\n\n当前可用图片目录：（空，还没有任何图片）';
  } else {
    const lines = catalog.map(entry => `[${entry.imgId}] ${entry.description}`).join('\n');
    instructions += `\n\n当前可用图片目录：\n${lines}`;
  }

  return instructions;
}

function buildInputMessages(history: AgentMessage[]) {
  return history
    .filter(message => message.role !== 'system-note' && message.role !== 'context-divider' && message.text.trim().length > 0)
    .map(message => (
      message.role === 'user'
        ? { role: 'user' as const, content: [{ type: 'input_text' as const, text: message.text }] }
        : { role: 'assistant' as const, content: [{ type: 'output_text' as const, text: message.text }] }
    ));
}

function buildChatMessages(history: AgentMessage[], instructions: string) {
  return [
    { role: 'system' as const, content: instructions },
    ...history
      .filter(message => message.role !== 'system-note' && message.role !== 'context-divider' && message.text.trim().length > 0)
      .map(message => ({
        role: message.role === 'user' ? 'user' as const : 'assistant' as const,
        content: message.text,
      })),
  ];
}

function buildAnthropicMessages(history: AgentMessage[]) {
  return history
    .filter(message => message.role !== 'system-note' && message.role !== 'context-divider' && message.text.trim().length > 0)
    .map(message => ({
      role: message.role === 'user' ? 'user' as const : 'assistant' as const,
      content: [{ type: 'text' as const, text: message.text }],
    }));
}

function buildGeminiContents(history: AgentMessage[], instructions: string) {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [
    { role: 'user', parts: [{ text: instructions }] },
  ];
  for (const message of history) {
    if (message.role === 'system-note' || message.role === 'context-divider' || message.text.trim().length === 0) continue;
    contents.push({
      role: message.role === 'user' ? 'user' : 'model',
      parts: [{ text: message.text }],
    });
  }
  return contents;
}

interface ResponsesEventEnvelope {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  item?: { type?: string; name?: string; arguments?: string };
  response?: {
    output_text?: string;
    output?: Array<{ type?: string; name?: string; arguments?: string }>;
  };
  error?: { message?: string };
  message?: string;
}

interface ChatCompletionsEventEnvelope {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        index?: number;
        function?: { arguments?: string };
      }>;
    };
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{ function?: { arguments?: string } }>;
    };
  }>;
  error?: { message?: string };
  message?: string;
}

interface MessagesEventEnvelope {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    text?: string;
    input?: unknown;
  };
  delta?: {
    text?: string;
    partial_json?: string;
  };
  error?: { message?: string };
  message?: { content?: Array<{ type?: string; text?: string; input?: unknown }> };
}

function normalizeAction(value: unknown): AgentActionType {
  return value === 'edit' ? 'edit' : 'generate';
}

function parseProposalArguments(raw: string): AgentProposal | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = normalizeAction(parsed.action);
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    const ids = Array.isArray(parsed.referenced_image_ids)
      ? parsed.referenced_image_ids.filter((id): id is string => typeof id === 'string')
      : [];
    if (prompt.trim().length === 0) return null;

    const requestedAspectRatio = typeof parsed.requested_aspect_ratio === 'string' && parsed.requested_aspect_ratio.trim().length > 0
      ? parsed.requested_aspect_ratio.trim()
      : undefined;
    const suggestedAspectRatio = typeof parsed.suggested_aspect_ratio === 'string' && parsed.suggested_aspect_ratio.trim().length > 0
      ? parsed.suggested_aspect_ratio.trim()
      : undefined;
    const requestedOutputSize = typeof parsed.requested_output_size === 'string' && parsed.requested_output_size.trim().length > 0
      ? parsed.requested_output_size.trim()
      : undefined;
    const temperature = typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)
      ? parsed.temperature
      : undefined;
    const parallelCount = typeof parsed.parallel_count === 'number' && Number.isFinite(parsed.parallel_count)
      ? parsed.parallel_count
      : undefined;
    const gptImageQuality = normalizeGptImageQuality(typeof parsed.gpt_image_quality === 'string' ? parsed.gpt_image_quality : undefined);
    const gptImageStyle = normalizeGptImageStyle(typeof parsed.gpt_image_style === 'string' ? parsed.gpt_image_style : undefined);
    const gptImageBackground = normalizeGptImageBackground(typeof parsed.gpt_image_background === 'string' ? parsed.gpt_image_background : undefined);
    const requestedModelId = typeof parsed.requested_model_id === 'string' && parsed.requested_model_id.trim().length > 0
      ? parsed.requested_model_id.trim()
      : undefined;

    return {
      action,
      prompt,
      reason,
      referencedImageIds: ids,
      requestedAspectRatio,
      suggestedAspectRatio,
      requestedOutputSize,
      temperature,
      parallelCount,
      gptImageQuality,
      gptImageStyle,
      gptImageBackground,
      requestedModelId,
    };
  } catch {
    return null;
  }
}

export function streamAgentChat(
  input: StreamAgentInput,
  callbacks: StreamAgentCallbacks,
  baseUrl: string = '',
): StreamAgentHandle {
  const controller = new AbortController();

  const promise = (async () => {
    try {
      await runAgentStreamWithRetry(baseUrl, input, callbacks, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      callbacks.onError(normalizeStreamError(err));
    }
  })();

  return {
    abort: () => controller.abort(),
    promise,
  };
}

async function runAgentStreamWithRetry(
  baseUrl: string,
  input: StreamAgentInput,
  callbacks: StreamAgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= AGENT_GPT_REQUEST_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) return;
    try {
      await runAttemptWithTimeout(
        attemptSignal => runAgentStream(baseUrl, input, callbacks, attemptSignal),
        signal,
        AGENT_CHAT_ATTEMPT_TIMEOUT_MS,
      );
      return;
    } catch (err) {
      if (signal.aborted) return;
      const normalized = normalizeStreamError(err);
      lastError = normalized;
      if (attempt >= AGENT_GPT_REQUEST_MAX_ATTEMPTS || !isRetryableAgentError(err)) {
        throw normalized;
      }
      callbacks.onResetAttempt?.();
      callbacks.onRetry?.(attempt + 1, AGENT_GPT_REQUEST_MAX_ATTEMPTS, normalized);
    }
  }
  throw lastError || new Error('模型请求失败');
}

async function runAgentStream(
  baseUrl: string,
  input: StreamAgentInput,
  callbacks: StreamAgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const instructions = buildInstructions(input.catalog, input.modelCatalog);
  const body = buildAgentRequestBody(input.protocol, input.model || AGENT_TEXT_MODEL_FALLBACK, input.history, instructions, Boolean(input.webSearch));

  const response = await fetch('/api/nova/proxy/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: input.protocol,
      baseUrl,
      apiKey: input.apiKey,
      model: input.model,
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
  let toolArgs = '';
  let fired = false;
  const toolArgsByIndex = new Map<number, string>();

  const fireDone = () => {
    if (fired) return;
    fired = true;
    callbacks.onDone(accumulated, parseProposalArguments(toolArgs));
  };

  await readSseStream(response.body, signal, (event) => {
    if (!event.data) return;
    if (event.data === '[DONE]') {
      fireDone();
      return;
    }

    let payload: ResponsesEventEnvelope | ChatCompletionsEventEnvelope | MessagesEventEnvelope | Record<string, unknown>;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    handleAgentStreamEvent(input.protocol, payload, event.event || '', callbacks, {
      accumulated,
      setAccumulated: next => { accumulated = next; },
      toolArgs,
      setToolArgs: next => { toolArgs = next; },
      toolArgsByIndex,
      fireDone,
    });
  });

  fireDone();
}

export async function describeImage(
  apiKey: string,
  model: string,
  protocol: TextProviderProtocol,
  imageDataUrl: string,
  signal?: AbortSignal,
  baseUrl: string = '',
): Promise<string> {
  return runAgentRequestWithRetry(
    attemptSignal => requestImageDescription(baseUrl, apiKey, model, protocol, imageDataUrl, attemptSignal),
    signal,
    AGENT_IMAGE_DESCRIBE_ATTEMPT_TIMEOUT_MS,
  );
}

async function requestImageDescription(
  baseUrl: string,
  apiKey: string,
  model: string,
  protocol: TextProviderProtocol,
  imageDataUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const body = buildSimpleProxyTextRequestBody(
    protocol,
    model || AGENT_TEXT_MODEL_FALLBACK,
    [
      { type: 'text', text: AGENT_IMAGE_DESCRIBE_PROMPT },
      { type: 'image', imageDataUrl },
    ],
    { reasoningEffort: 'low' }
  );

  const response = await fetch('/api/nova/proxy/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol,
      baseUrl,
      apiKey,
      model,
      stream: false,
      requestBody: body,
    }),
    signal,
  });

  if (!response.ok) {
    throw await readHttpError(response);
  }

  const data = await response.json().catch(() => null);
  if (!data) return '';
  return extractTextOutput(protocol, data).trim();
}

function buildAgentRequestBody(
  protocol: TextProviderProtocol,
  model: string,
  history: AgentMessage[],
  instructions: string,
  enableNativeWebSearch: boolean,
) {
  if (protocol === 'openai-chat-completions') {
    return {
      model,
      stream: true,
      messages: buildChatMessages(history, instructions),
      tools: [
        {
          type: 'function' as const,
          function: {
            name: PROPOSE_IMAGE_ACTION_TOOL.name,
            description: PROPOSE_IMAGE_ACTION_TOOL.description,
            parameters: PROPOSE_IMAGE_ACTION_TOOL.parameters,
          },
        },
      ],
      tool_choice: 'auto' as const,
    };
  }

  if (protocol === 'anthropic-messages') {
    return {
      model,
      stream: true,
      max_tokens: 4096,
      system: instructions,
      messages: buildAnthropicMessages(history),
      tools: [
        {
          name: PROPOSE_IMAGE_ACTION_TOOL.name,
          description: PROPOSE_IMAGE_ACTION_TOOL.description,
          input_schema: PROPOSE_IMAGE_ACTION_TOOL.parameters,
        },
        ...(enableNativeWebSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : []),
      ],
    };
  }

  if (protocol === 'google-gemini') {
    return {
      contents: buildGeminiContents(history, instructions),
      tools: [
        {
          function_declarations: [
            {
              name: PROPOSE_IMAGE_ACTION_TOOL.name,
              description: PROPOSE_IMAGE_ACTION_TOOL.description,
              parameters: PROPOSE_IMAGE_ACTION_TOOL.parameters,
            },
          ],
        },
        ...(enableNativeWebSearch ? [{ google_search: {} }] : []),
      ],
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: -1,
          includeThoughts: false,
        },
      },
    };
  }

  return {
    model,
    stream: true,
    reasoning: { effort: 'medium' as const, summary: 'detailed' as const },
    instructions,
    tools: enableNativeWebSearch
      ? [PROPOSE_IMAGE_ACTION_TOOL, { type: 'web_search' as const }]
      : [PROPOSE_IMAGE_ACTION_TOOL],
    tool_choice: 'auto' as const,
    input: buildInputMessages(history),
  };
}

function handleAgentStreamEvent(
  protocol: TextProviderProtocol,
  payload: ResponsesEventEnvelope | ChatCompletionsEventEnvelope | MessagesEventEnvelope | Record<string, unknown>,
  rawEventType: string,
  callbacks: StreamAgentCallbacks,
  state: {
    accumulated: string;
    setAccumulated: (value: string) => void;
    toolArgs: string;
    setToolArgs: (value: string) => void;
    toolArgsByIndex: Map<number, string>;
    fireDone: () => void;
  },
) {
  if (protocol === 'openai-chat-completions') {
    const chunk = payload as ChatCompletionsEventEnvelope;
    if (rawEventType === 'error' || chunk.error?.message) {
      throw new Error(chunk.error?.message || chunk.message || '模型返回错误');
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const deltaContent = choice.delta?.content;
    const textDelta = typeof deltaContent === 'string'
      ? deltaContent
      : Array.isArray(deltaContent)
        ? deltaContent.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
        : '';
    if (textDelta) {
      state.setAccumulated(state.accumulated + textDelta);
      callbacks.onDelta(textDelta);
    }

    for (const toolCall of choice.delta?.tool_calls || []) {
      const index = typeof toolCall.index === 'number' ? toolCall.index : 0;
      const fragment = toolCall.function?.arguments || '';
      if (!fragment) continue;
      const next = `${state.toolArgsByIndex.get(index) || ''}${fragment}`;
      state.toolArgsByIndex.set(index, next);
      state.setToolArgs(next);
    }

    for (const toolCall of choice.message?.tool_calls || []) {
      const fullArgs = toolCall.function?.arguments;
      if (typeof fullArgs === 'string' && fullArgs.length > 0) {
        state.setToolArgs(fullArgs);
      }
    }
    return;
  }

  if (protocol === 'anthropic-messages') {
    const chunk = payload as MessagesEventEnvelope;
    const eventType = chunk.type || rawEventType || '';
    if (eventType === 'content_block_start') {
      if (chunk.content_block?.type === 'text' && typeof chunk.content_block.text === 'string') {
        state.setAccumulated(state.accumulated + chunk.content_block.text);
        callbacks.onDelta(chunk.content_block.text);
      }
      if (chunk.content_block?.type === 'tool_use' && chunk.content_block.input && typeof chunk.index === 'number') {
        const serialized = JSON.stringify(chunk.content_block.input);
        state.toolArgsByIndex.set(chunk.index, serialized);
        state.setToolArgs(serialized);
      }
      return;
    }
    if (eventType === 'content_block_delta') {
      if (typeof chunk.delta?.text === 'string') {
        state.setAccumulated(state.accumulated + chunk.delta.text);
        callbacks.onDelta(chunk.delta.text);
      }
      if (typeof chunk.delta?.partial_json === 'string') {
        const index = typeof chunk.index === 'number' ? chunk.index : 0;
        const next = `${state.toolArgsByIndex.get(index) || ''}${chunk.delta.partial_json}`;
        state.toolArgsByIndex.set(index, next);
        state.setToolArgs(next);
      }
      return;
    }
    if (eventType === 'message_stop') {
      const finalTool = chunk.message?.content?.find(part => part.type === 'tool_use' && part.input);
      if (finalTool?.input && state.toolArgs.trim().length === 0) {
        state.setToolArgs(JSON.stringify(finalTool.input));
      }
      state.fireDone();
      return;
    }
    if (eventType === 'error') {
      throw new Error(chunk.error?.message || '模型返回错误');
    }
    return;
  }

  if (protocol === 'google-gemini') {
    const chunk = payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } }> } }>;
      error?: { message?: string };
    };
    if (chunk.error?.message) throw new Error(chunk.error.message);
    for (const candidate of chunk.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.thought === true) continue;
        if (typeof part.text === 'string' && part.text.length > 0) {
          state.setAccumulated(state.accumulated + part.text);
          callbacks.onDelta(part.text);
        }
        if (part.functionCall?.name === PROPOSE_IMAGE_ACTION_TOOL.name && part.functionCall.args) {
          state.setToolArgs(JSON.stringify(part.functionCall.args));
        }
      }
    }
    return;
  }

  const chunk = payload as ResponsesEventEnvelope;
  const eventType = chunk.type || rawEventType || '';
  if (eventType === 'response.reasoning_summary_text.delta') {
    const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
    if (delta) callbacks.onReasoning(delta);
    return;
  }
  if (eventType === 'response.reasoning_summary_part.added') {
    callbacks.onReasoning('\n');
    return;
  }
  if (eventType === 'response.output_text.delta') {
    const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
    if (delta) {
      state.setAccumulated(state.accumulated + delta);
      callbacks.onDelta(delta);
    }
    return;
  }
  if (eventType === 'response.output_text.done') {
    if (typeof chunk.text === 'string' && chunk.text.length > state.accumulated.length) {
      const tail = chunk.text.slice(state.accumulated.length);
      if (tail) {
        state.setAccumulated(chunk.text);
        callbacks.onDelta(tail);
      }
    }
    return;
  }
  if (eventType === 'response.function_call_arguments.delta') {
    if (typeof chunk.delta === 'string') {
      state.setToolArgs(state.toolArgs + chunk.delta);
    }
    return;
  }
  if (eventType === 'response.function_call_arguments.done') {
    if (typeof chunk.arguments === 'string' && chunk.arguments.length > 0) {
      state.setToolArgs(chunk.arguments);
    }
    return;
  }
  if (eventType === 'response.output_item.done') {
    if (chunk.item?.type === 'function_call' && typeof chunk.item.arguments === 'string' && chunk.item.arguments.length > 0) {
      state.setToolArgs(chunk.item.arguments);
    }
    return;
  }
  if (eventType === 'response.completed') {
    const fullText = chunk.response?.output_text;
    if (typeof fullText === 'string' && fullText.length > state.accumulated.length) {
      const tail = fullText.slice(state.accumulated.length);
      if (tail) {
        state.setAccumulated(fullText);
        callbacks.onDelta(tail);
      }
    }
    const call = chunk.response?.output?.find(item => item.type === 'function_call' && typeof item.arguments === 'string');
    if (call?.arguments && state.toolArgs.trim().length === 0) {
      state.setToolArgs(call.arguments);
    }
    state.fireDone();
    return;
  }
  if (eventType === 'error' || eventType === 'response.error') {
    throw new Error(chunk.error?.message || chunk.message || '模型返回错误');
  }
}

function createAttemptSignal(parentSignal?: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!parentSignal) {
    return {
      signal: controller.signal,
      abort: reason => controller.abort(reason),
      cleanup: () => undefined,
    };
  }
  if (parentSignal.aborted) controller.abort(parentSignal.reason);
  const abortFromParent = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    abort: reason => controller.abort(reason),
    cleanup: () => parentSignal.removeEventListener('abort', abortFromParent),
  };
}

async function runAttemptWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const attempt = createAttemptSignal(parentSignal);
  const timeoutError = new AgentRequestTimeoutError(timeoutMs);
  const timeoutId = window.setTimeout(() => {
    if (!attempt.signal.aborted) attempt.abort(timeoutError);
  }, timeoutMs);

  try {
    return await request(attempt.signal);
  } catch (err) {
    if (attempt.signal.reason instanceof AgentRequestTimeoutError) {
      throw attempt.signal.reason;
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
    attempt.cleanup();
  }
}

async function runAgentRequestWithRetry<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= AGENT_GPT_REQUEST_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    try {
      return await runAttemptWithTimeout(request, signal, timeoutMs);
    } catch (err) {
      if (signal?.aborted) throw err;
      const normalized = normalizeStreamError(err);
      lastError = normalized;
      if (attempt >= AGENT_GPT_REQUEST_MAX_ATTEMPTS || !isRetryableAgentError(err)) {
        throw normalized;
      }
    }
  }
  throw lastError || new Error('模型请求失败');
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
      // ignore
    }
  }
  return new Error(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

function isRetryableAgentError(error: unknown): boolean {
  if (error instanceof AgentRequestTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return [
    '408',
    '409',
    '425',
    '429',
    '500',
    '502',
    '503',
    '504',
    'failed to fetch',
    'network',
    'load failed',
    'econnreset',
    'terminated',
    'timeout',
    'timed out',
    '超时',
    '超过',
    'rate limit',
    'temporarily',
    'overloaded',
  ].some(keyword => lower.includes(keyword));
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof AgentRequestTimeoutError) {
    return new Error(`${error.message}，已自动重试 ${AGENT_GPT_REQUEST_MAX_ATTEMPTS} 次仍未成功`);
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      lower.includes('failed to fetch')
      || lower.includes('network')
      || lower.includes('load failed')
      || lower.includes('econnreset')
      || lower.includes('terminated')
    ) {
      return new Error(`网络连接失败，已自动重试 ${AGENT_GPT_REQUEST_MAX_ATTEMPTS} 次仍未成功`);
    }
    return error;
  }
  return new Error(String(error));
}
