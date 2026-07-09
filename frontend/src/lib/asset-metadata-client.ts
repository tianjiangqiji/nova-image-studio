'use client';

import { getConfiguredTextModel } from '@/lib/model-endpoints';
import {
  buildSimpleProxyTextRequestBody,
  extractTextOutput,
} from '@/lib/nova-proxy-text';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

const ASSET_METADATA_MODEL = 'gpt-5.4-mini';

export interface AssetMetadataSuggestion {
  name: string;
  tags: string[];
  note: string;
}

export interface GenerateAssetMetadataInput {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  imageDataUrl: string;
  currentName: string;
  currentTags: string[];
  currentNote: string;
}

function parseSuggestion(text: string): AssetMetadataSuggestion {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(cleaned) as Partial<AssetMetadataSuggestion>;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8)
    : [];

  if (!name || tags.length === 0 || !note) {
    throw new Error('模型返回的标题、标签或备注不完整');
  }

  return { name, tags: Array.from(new Set(tags)), note };
}

export async function generateAssetMetadata(input: GenerateAssetMetadataInput): Promise<AssetMetadataSuggestion> {
  const configured = getConfiguredTextModel(input.model || ASSET_METADATA_MODEL);
  const protocol = (configured?.protocol || 'openai-responses') as TextProviderProtocol;
  const actualModel = configured?.modelId || input.model || ASSET_METADATA_MODEL;
  const baseUrl = configured?.baseUrl || input.baseUrl || 'https://api.openai.com';

  const prompt = [
    '请观察这张图片，为个人素材库生成一组中文元数据。',
    '只输出 JSON，不要 Markdown，不要解释。',
    'JSON 结构必须是 {"name":"短标题","tags":["标签1","标签2"],"note":"图片内容和用途描述"}。',
    '标题 6 到 24 个中文字符；标签 3 到 8 个，短词；备注 1 到 3 句。',
    '',
    `当前标题：${input.currentName || '(空)'}`,
    `当前标签：${input.currentTags.join('、') || '(空)'}`,
    `当前备注：${input.currentNote || '(空)'}`,
  ].join('\n');

  const body = buildSimpleProxyTextRequestBody(
    protocol,
    actualModel,
    [
      { type: 'text', text: prompt },
      { type: 'image', imageDataUrl: input.imageDataUrl },
    ],
    { reasoningEffort: 'low' }
  );

  const response = await fetch('/api/nova/proxy/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol,
      baseUrl,
      apiKey: input.apiKey,
      model: actualModel,
      stream: false,
      requestBody: body,
    }),
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      message = data?.error?.message || data?.message || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const text = extractTextOutput(protocol, await response.json());
  if (!text.trim()) throw new Error('模型没有返回素材信息');
  return parseSuggestion(text);
}
