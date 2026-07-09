'use client';

export type TextProviderProtocol =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-gemini';

export interface TextProtocolCapabilities {
  supportsReasoningSummary: boolean;
  supportsNativeWebSearch: boolean;
  supportsFunctionTools: boolean;
}

const TEXT_PROTOCOL_CAPABILITIES: Record<TextProviderProtocol, TextProtocolCapabilities> = {
  'openai-responses': {
    supportsReasoningSummary: true,
    supportsNativeWebSearch: true,
    supportsFunctionTools: true,
  },
  'openai-chat-completions': {
    supportsReasoningSummary: false,
    supportsNativeWebSearch: false,
    supportsFunctionTools: true,
  },
  'anthropic-messages': {
    supportsReasoningSummary: false,
    supportsNativeWebSearch: true,
    supportsFunctionTools: true,
  },
  'google-gemini': {
    supportsReasoningSummary: false,
    supportsNativeWebSearch: true,
    supportsFunctionTools: true,
  },
};

export function isTextProviderProtocol(value: unknown): value is TextProviderProtocol {
  return value === 'openai-responses'
    || value === 'openai-chat-completions'
    || value === 'anthropic-messages'
    || value === 'google-gemini';
}

export function getTextProtocolCapabilities(protocol: TextProviderProtocol): TextProtocolCapabilities {
  return TEXT_PROTOCOL_CAPABILITIES[protocol];
}

export function getTextProviderLabel(protocol: TextProviderProtocol): string {
  switch (protocol) {
    case 'openai-chat-completions':
      return 'OpenAI Chat';
    case 'anthropic-messages':
      return 'Claude Messages';
    case 'google-gemini':
      return 'Gemini v1beta';
    case 'openai-responses':
    default:
      return 'OpenAI Responses';
  }
}

export function getTextProviderDescription(protocol: TextProviderProtocol): string {
  switch (protocol) {
    case 'openai-chat-completions':
      return 'OpenAI 兼容 Chat Completions；不支持原生联网搜索';
    case 'anthropic-messages':
      return 'Claude Messages；支持原生联网搜索';
    case 'google-gemini':
      return 'Google Gemini v1beta；支持原生 Google Search';
    case 'openai-responses':
    default:
      return 'OpenAI Responses；支持原生联网搜索';
  }
}
