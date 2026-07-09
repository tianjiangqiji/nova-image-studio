// 反推提示词流式客户端
// 统一通过 /api/nova/proxy/text 按文本协议转发。

import {
  REVERSE_PROMPT_TEMPLATES,
  type ReversePromptMode,
  type ReversePromptModelId,
} from '@/lib/reverse-prompt-config';
import { getConfiguredTextModel } from '@/lib/model-endpoints';
import {
  buildSimpleProxyTextRequestBody,
  handleSimpleTextStreamEvent,
} from '@/lib/nova-proxy-text';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import { readSseStream } from '@/lib/sse-stream-parser';

export interface StreamReverseInput {
  apiKey: string;
  model: ReversePromptModelId;
  mode: ReversePromptMode;
  imageDataUrl: string;
  mimeType: string;
}

export interface StreamReverseCallbacks {
  onDelta(token: string): void;
  onDone(fullText: string): void;
  onError(err: Error): void;
}

export interface StreamReverseHandle {
  abort(): void;
  promise: Promise<void>;
}

export function streamReversePrompt(
  input: StreamReverseInput,
  callbacks: StreamReverseCallbacks,
  baseUrl: string = '',
): StreamReverseHandle {
  const controller = new AbortController();

  const promise = (async () => {
    try {
      const configuredModel = getConfiguredTextModel(input.model);
      const protocol = (configuredModel?.protocol || 'openai-responses') as TextProviderProtocol;
      const resolvedBaseUrl = configuredModel?.baseUrl || baseUrl;
      const resolvedModelId = configuredModel?.modelId || input.model;
      await streamTextProtocol(protocol, resolvedBaseUrl, { ...input, model: resolvedModelId }, callbacks, controller.signal);
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

async function streamTextProtocol(
  protocol: TextProviderProtocol,
  baseUrl: string,
  input: StreamReverseInput,
  callbacks: StreamReverseCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const body = buildSimpleProxyTextRequestBody(
    protocol,
    input.model,
    [
      { type: 'text', text: REVERSE_PROMPT_TEMPLATES[input.mode] },
      { type: 'image', imageDataUrl: input.imageDataUrl, mimeType: input.mimeType },
    ],
    { stream: true, reasoningEffort: 'high' }
  );

  const response = await fetch('/api/nova/proxy/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol,
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
      const message =
        parsed?.error?.message
        || parsed?.error
        || parsed?.message;
      if (typeof message === 'string' && message.length > 0) {
        return new Error(`${response.status} ${response.statusText}: ${message}`);
      }
    } catch {
      // 不是 JSON
    }
  }
  return new Error(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      lower.includes('failed to fetch')
      || lower.includes('network')
      || lower.includes('load failed')
      || lower.includes('econnreset')
      || lower.includes('terminated')
    ) {
      return new Error('网络连接失败，请检查网络后重试');
    }
    return error;
  }
  return new Error(String(error));
}
