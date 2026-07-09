'use client';

import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

export type TextContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageDataUrl: string; mimeType?: string };

export function buildSimpleProxyTextRequestBody(
  protocol: TextProviderProtocol,
  model: string,
  parts: TextContentPart[],
  options: {
    stream?: boolean;
    systemInstruction?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
    maxTokens?: number;
  } = {},
) {
  const { stream = false, systemInstruction, reasoningEffort, maxTokens } = options;

  if (protocol === 'openai-chat-completions') {
    return {
      model,
      ...(stream ? { stream: true } : {}),
      messages: [
        ...(systemInstruction ? [{ role: 'system' as const, content: systemInstruction }] : []),
        {
          role: 'user' as const,
          content: buildChatCompletionsContent(parts),
        },
      ],
    };
  }

  if (protocol === 'anthropic-messages') {
    return {
      model,
      ...(stream ? { stream: true } : {}),
      max_tokens: maxTokens || 2048,
      ...(systemInstruction ? { system: systemInstruction } : {}),
      messages: [
        {
          role: 'user' as const,
          content: buildAnthropicContent(parts),
        },
      ],
    };
  }

  if (protocol === 'google-gemini') {
    const textPrefix = systemInstruction ? `${systemInstruction}\n\n---\n\n` : '';
    return {
      contents: [
        {
          role: 'user' as const,
          parts: buildGeminiParts([
            ...(textPrefix ? [{ type: 'text' as const, text: textPrefix }] : []),
            ...parts,
          ]),
        },
      ],
      ...(reasoningEffort ? { generationConfig: buildGeminiGenerationConfig(reasoningEffort) } : {}),
    };
  }

  return {
    model,
    ...(stream ? { stream: true } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(systemInstruction ? { instructions: systemInstruction } : {}),
    input: [
      {
        role: 'user' as const,
        content: buildResponsesInputContent(parts),
      },
    ],
  };
}

export function handleSimpleTextStreamEvent(
  protocol: TextProviderProtocol,
  payload: Record<string, unknown>,
  rawEventType: string,
  accumulated: string,
  onDelta: (token: string) => void,
  onDone: () => void,
): string {
  if (protocol === 'openai-chat-completions') {
    const record = payload as {
      choices?: Array<{
        delta?: { content?: string | Array<{ type?: string; text?: string }> };
        message?: { content?: string | Array<{ type?: string; text?: string }> };
      }>;
      error?: { message?: string };
      message?: string;
    };
    if (rawEventType === 'error' || record.error?.message) {
      throw new Error(record.error?.message || record.message || '模型返回错误');
    }
    const content = record.choices?.[0]?.delta?.content ?? record.choices?.[0]?.message?.content;
    const delta = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
        : '';
    if (delta) {
      accumulated += delta;
      onDelta(delta);
    }
    return accumulated;
  }

  if (protocol === 'anthropic-messages') {
    const record = payload as {
      type?: string;
      delta?: { text?: string };
      content_block?: { type?: string; text?: string };
      error?: { message?: string };
    };
    const eventType = record.type || rawEventType || '';
    if (eventType === 'content_block_start' && record.content_block?.type === 'text' && typeof record.content_block.text === 'string') {
      accumulated += record.content_block.text;
      onDelta(record.content_block.text);
      return accumulated;
    }
    if (eventType === 'content_block_delta' && typeof record.delta?.text === 'string') {
      accumulated += record.delta.text;
      onDelta(record.delta.text);
      return accumulated;
    }
    if (eventType === 'message_stop') {
      onDone();
      return accumulated;
    }
    if (eventType === 'error') {
      throw new Error(record.error?.message || '模型返回错误');
    }
    return accumulated;
  }

  if (protocol === 'google-gemini') {
    const record = payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      promptFeedback?: { blockReason?: string };
      error?: { message?: string };
    };
    if (record.error?.message) throw new Error(record.error.message);
    if (record.promptFeedback?.blockReason) throw new Error(`内容被拦截: ${record.promptFeedback.blockReason}`);
    for (const candidate of record.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.thought === true) continue;
        if (typeof part.text === 'string' && part.text.length > 0) {
          accumulated += part.text;
          onDelta(part.text);
        }
      }
    }
    return accumulated;
  }

  const record = payload as {
    type?: string;
    delta?: string;
    text?: string;
    response?: { output_text?: string };
    error?: { message?: string };
    message?: string;
  };
  const eventType = record.type || rawEventType || '';
  if (eventType === 'response.output_text.delta') {
    const delta = typeof record.delta === 'string' ? record.delta : '';
    if (delta) {
      accumulated += delta;
      onDelta(delta);
    }
    return accumulated;
  }
  if (eventType === 'response.output_text.done') {
    if (typeof record.text === 'string' && record.text.length > accumulated.length) {
      const tail = record.text.slice(accumulated.length);
      if (tail) {
        accumulated = record.text;
        onDelta(tail);
      }
    }
    return accumulated;
  }
  if (eventType === 'response.completed') {
    const fullText = record.response?.output_text;
    if (typeof fullText === 'string' && fullText.length > accumulated.length) {
      const tail = fullText.slice(accumulated.length);
      if (tail) {
        accumulated = fullText;
        onDelta(tail);
      }
    }
    onDone();
    return accumulated;
  }
  if (eventType === 'error' || eventType === 'response.error') {
    throw new Error(record.error?.message || record.message || '模型返回错误');
  }
  return accumulated;
}

export function extractTextOutput(protocol: TextProviderProtocol, data: unknown): string {
  if (!data || typeof data !== 'object') return '';

  if (protocol === 'openai-chat-completions') {
    const record = data as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const content = record.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
  }

  if (protocol === 'anthropic-messages') {
    const record = data as { content?: Array<{ type?: string; text?: string }> };
    return (record.content || [])
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
  }

  if (protocol === 'google-gemini') {
    const record = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return (record.candidates || [])
      .flatMap(candidate => candidate.content?.parts || [])
      .map(part => part.text || '')
      .join('');
  }

  const record = data as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof record.output_text === 'string') return record.output_text;
  return (record.output || [])
    .flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

export function parseDataUrl(
  dataUrl: string,
  fallbackMimeType = 'image/png',
): { base64: string; mimeType: string } {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    return {
      mimeType: fallbackMimeType,
      base64: dataUrl,
    };
  }
  return {
    mimeType: match[1] || fallbackMimeType,
    base64: match[2],
  };
}

function buildResponsesInputContent(parts: TextContentPart[]) {
  return parts.map(part => (
    part.type === 'text'
      ? { type: 'input_text' as const, text: part.text }
      : { type: 'input_image' as const, image_url: part.imageDataUrl }
  ));
}

function buildChatCompletionsContent(parts: TextContentPart[]) {
  return parts.map(part => (
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: part.imageDataUrl } }
  ));
}

function buildAnthropicContent(parts: TextContentPart[]) {
  return parts.map(part => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text };
    }
    const parsed = parseDataUrl(part.imageDataUrl, part.mimeType || 'image/png');
    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: parsed.mimeType,
        data: parsed.base64,
      },
    };
  });
}

function buildGeminiParts(parts: TextContentPart[]) {
  return parts.map(part => {
    if (part.type === 'text') return { text: part.text };
    const parsed = parseDataUrl(part.imageDataUrl, part.mimeType || 'image/png');
    return { inline_data: { mime_type: parsed.mimeType, data: parsed.base64 } };
  });
}

function buildGeminiGenerationConfig(effort: 'low' | 'medium' | 'high') {
  const budget = effort === 'high' ? -1 : effort === 'medium' ? 4096 : 1024;
  return {
    thinkingConfig: {
      thinkingBudget: budget,
      includeThoughts: false,
    },
  };
}
