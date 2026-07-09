'use client';

import {
  getDefaultTextModel,
  getTextModelById,
  loadRegistry,
  type ProviderProtocol,
  type TextModelConfig,
} from '@/lib/nova-models';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

function trimTrailingSlashes(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function ensureOpenAiBaseUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl);
  if (!normalized) return '';
  return normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
}

function ensureGoogleBaseUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl);
  if (!normalized) return '';
  return normalized.endsWith('/v1beta') ? normalized.slice(0, -7) : normalized;
}

export function normalizeModelBaseUrl(protocol: ProviderProtocol, baseUrl: string): string {
  return protocol === 'google'
    ? ensureGoogleBaseUrl(baseUrl)
    : ensureOpenAiBaseUrl(baseUrl);
}

export function normalizeTextModelBaseUrl(protocol: TextProviderProtocol, baseUrl: string): string {
  return protocol === 'google-gemini'
    ? ensureGoogleBaseUrl(baseUrl)
    : ensureOpenAiBaseUrl(baseUrl);
}

export function buildResponsesApiUrl(baseUrl: string): string {
  return `${ensureOpenAiBaseUrl(baseUrl)}/v1/responses`;
}

export function buildGeminiStreamGenerateContentUrl(baseUrl: string, modelId: string): string {
  return `${ensureGoogleBaseUrl(baseUrl)}/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

export function getConfiguredTextModel(modelId: string): TextModelConfig | undefined {
  const registry = loadRegistry();
  return getTextModelById(registry, modelId);
}

export function getDefaultConfiguredTextModel(
  task: 'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe',
): TextModelConfig | undefined {
  const registry = loadRegistry();
  return getDefaultTextModel(registry, task);
}

export function requireDefaultConfiguredTextModel(
  task: 'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe',
): TextModelConfig {
  const configured = getDefaultConfiguredTextModel(task);
  if (!configured?.apiKey || !configured.baseUrl || !configured.modelId) {
    throw new Error('请先在设置中完成默认文本模型配置');
  }
  return configured;
}
