// Agent 模式的浏览器直连客户端
// 文本对话与视觉描述统一通过 /api/nova/proxy/text，按文本协议动态转发。

import {
  AGENT_TEXT_MODEL_FALLBACK,
  AGENT_SYSTEM_INSTRUCTIONS,
  AGENT_CDP_SYSTEM_SUFFIX,
  AGENT_IMAGE_DESCRIBE_PROMPT,
  PROPOSE_IMAGE_ACTION_TOOL,
  extractProductLinks,
  normalizeProductKey,
  type AgentMessage,
  type AgentProposal,
  type AgentActionType,
} from '@/lib/agent-chat-config';
import { AGENT_CDP_TOOLS, isAgentCdpTool, normalizeCdpToolName } from '@/lib/agent-cdp-tools';
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
  /** 商品作用域；同一提案只能引用同一 productKey 的图片 */
  productKey?: string;
  productName?: string;
}

export interface StreamAgentInput {
  apiKey: string;
  model: string;
  protocol: TextProviderProtocol;
  history: AgentMessage[];
  catalog: AgentCatalogEntry[];
  modelCatalog: AgentModelCatalogEntry[];
  webSearch?: boolean;
  /** 开启后向模型声明浏览器 CDP 工具，并在本轮对话中执行工具循环 */
  cdp?: boolean;
  /** CDP 工具执行器（一般由 useAgentChat 注入，负责把抓到的图片登记进图片目录） */
  cdpExecutor?: (name: string, args: Record<string, unknown>, onProgress?: (text: string) => void) => Promise<string>;
}

export interface StreamAgentCallbacks {
  onDelta(token: string): void;
  onReasoning(token: string): void;
  /** 第三个参数为同轮解析出的全部提案；旧调用方只消费前两个参数即可。 */
  onDone(fullText: string, proposal: AgentProposal | null, proposals?: AgentProposal[]): void;
  onRetry?(attempt: number, maxAttempts: number, err: Error): void;
  onResetAttempt?(): void;
  onError(err: Error): void;
  /** 工具循环中每次执行浏览器工具时回调，用于在思考流中展示 */
  onToolActivity?(text: string): void;
}

export interface StreamAgentHandle {
  abort(): void;
  promise: Promise<void>;
}

function buildInstructions(catalog: AgentCatalogEntry[], modelCatalog: AgentModelCatalogEntry[], cdpEnabled = false): string {
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
    const lines = catalog.map(entry => {
      const productLabel = entry.productName || entry.productKey;
      const scope = productLabel ? `｜所属商品：${productLabel}${entry.productKey && entry.productKey !== productLabel ? `（${entry.productKey}）` : ''}` : '';
      return `[${entry.imgId}] ${entry.description}${scope}`;
    }).join('\n');
    instructions += `\n\n当前可用图片目录：\n${lines}`;
  }

  if (cdpEnabled) {
    instructions += AGENT_CDP_SYSTEM_SUFFIX;
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
  output_index?: number;
  item_id?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    output_text?: string;
    output?: Array<{ type?: string; id?: string; call_id?: string; name?: string; arguments?: string }>;
  };
  error?: { message?: string };
  message?: string;
}

interface ChatCompletionsEventEnvelope {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
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
    id?: string;
    name?: string;
    text?: string;
    input?: unknown;
  };
  delta?: {
    text?: string;
    type?: string;
    thinking?: string;
    partial_json?: string;
  };
  error?: { message?: string };
  message?: { content?: Array<{ type?: string; id?: string; name?: string; text?: string; input?: unknown }> };
}

function normalizeAction(value: unknown): AgentActionType {
  return value === 'edit' ? 'edit' : 'generate';
}

const AGENT_MAX_PARALLEL_COUNT = 8;
const AGENT_RATIO_WORD_MAP: Record<string, string> = {
  正方形: '1:1',
  // 方向词映射必须与 system 指令（agent-chat-config.ts）一致：横屏=16:9、竖屏=9:16，
  // 否则模型按指令填 16:9/9:16 而兜底找 4:3/3:4，会重复补提案。
  竖版: '9:16',
  竖屏: '9:16',
  横版: '16:9',
  横屏: '16:9',
};

function canonicalizeAspectRatio(raw?: string): string | undefined {
  const value = (raw || '').trim().replace(/：/g, ':');
  if (!value) return undefined;
  return AGENT_RATIO_WORD_MAP[value] || value;
}

function clampParallelCount(count: number): number {
  return Math.min(AGENT_MAX_PARALLEL_COUNT, Math.max(1, Math.floor(count)));
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
      ? canonicalizeAspectRatio(parsed.requested_aspect_ratio)
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
    const productKeyValue = typeof parsed.product_key === 'string'
      ? parsed.product_key
      : typeof parsed.productKey === 'string'
        ? parsed.productKey
        : undefined;
    const productKey = productKeyValue?.trim() || undefined;
    const productNameValue = typeof parsed.product_name === 'string'
      ? parsed.product_name
      : typeof parsed.productName === 'string'
        ? parsed.productName
        : undefined;
    const productName = productNameValue?.trim() || undefined;

    return {
      action,
      prompt,
      reason,
      referencedImageIds: ids,
      productKey,
      productName,
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
      await runAgentStream(baseUrl, input, callbacks, controller.signal);
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

// ===== 多轮工具循环 =====

/** 单次对话中 CDP 工具循环的最大轮数（每轮 = 一次流式请求 + 若干工具执行）。
 * N 个商品的最短路径约 2N 轮（开页+提炼），5 个链接要 10 轮，留余量到 12。 */
const AGENT_CDP_MAX_TOOL_ROUNDS = 12;

interface CapturedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface RoundResult {
  text: string;
  toolCalls: CapturedToolCall[];
}

/** 协议原生的可变会话状态：每轮工具调用结束后按协议格式回灌 */
type ConversationState =
  | { kind: 'chat'; messages: Array<Record<string, unknown>> }
  | { kind: 'anthropic'; messages: Array<Record<string, unknown>> }
  | { kind: 'gemini'; contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> }
  | { kind: 'responses'; input: Array<Record<string, unknown>> };

function initConversationState(
  protocol: TextProviderProtocol,
  history: AgentMessage[],
  instructions: string,
): ConversationState {
  if (protocol === 'openai-chat-completions') {
    return { kind: 'chat', messages: buildChatMessages(history, instructions) as unknown as Array<Record<string, unknown>> };
  }
  if (protocol === 'anthropic-messages') {
    return { kind: 'anthropic', messages: buildAnthropicMessages(history) as unknown as Array<Record<string, unknown>> };
  }
  if (protocol === 'google-gemini') {
    return { kind: 'gemini', contents: buildGeminiContents(history, instructions) };
  }
  return { kind: 'responses', input: buildInputMessages(history) as unknown as Array<Record<string, unknown>> };
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 把本轮的助手工具调用与工具结果按协议原生格式追加进会话状态 */
function appendToolExchange(
  conversation: ConversationState,
  exchanges: Array<{ call: CapturedToolCall; result: string }>,
  roundText: string,
): void {
  // 统一补齐缺失的调用 id（gemini 无 id 概念，仅其他协议用到）
  const normalized = exchanges.map(({ call, result }, i) => ({
    id: call.id || `nova_call_${Date.now()}_${i}`,
    name: call.name,
    arguments: call.arguments || '{}',
    result,
  }));

  if (conversation.kind === 'chat') {
    conversation.messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: normalized.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    for (const call of normalized) {
      conversation.messages.push({ role: 'tool', tool_call_id: call.id, content: call.result });
    }
    return;
  }

  if (conversation.kind === 'anthropic') {
    const assistantContent: Array<Record<string, unknown>> = [];
    if (roundText) assistantContent.push({ type: 'text', text: roundText });
    for (const call of normalized) {
      assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: safeParseJsonObject(call.arguments) });
    }
    conversation.messages.push({ role: 'assistant', content: assistantContent });
    conversation.messages.push({
      role: 'user',
      content: normalized.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: call.result })),
    });
    return;
  }

  if (conversation.kind === 'gemini') {
    const modelParts: Array<Record<string, unknown>> = [];
    if (roundText) modelParts.push({ text: roundText });
    for (const call of normalized) {
      modelParts.push({ functionCall: { name: call.name, args: safeParseJsonObject(call.arguments) } });
    }
    conversation.contents.push({ role: 'model', parts: modelParts });
    conversation.contents.push({
      role: 'user',
      parts: normalized.map(call => ({ functionResponse: { name: call.name, response: { result: call.result } } })),
    });
    return;
  }

  if (roundText) {
    conversation.input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: roundText }] });
  }
  for (const call of normalized) {
    conversation.input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
  }
  for (const call of normalized) {
    conversation.input.push({ type: 'function_call_output', call_id: call.id, output: call.result });
  }
}

async function executeCdpCall(
  executor: NonNullable<StreamAgentInput['cdpExecutor']>,
  call: CapturedToolCall,
  onProgress?: (text: string) => void,
): Promise<string> {
  // safeParseJsonObject 对非法 JSON 兜底返回 {}，工具自己会报「参数错误：缺少 xx」
  const args = safeParseJsonObject(call.arguments);
  try {
    return await executor(call.name, args, onProgress);
  } catch (err) {
    return `工具 ${call.name} 执行失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function runAgentStream(
  baseUrl: string,
  input: StreamAgentInput,
  callbacks: StreamAgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const cdpEnabled = Boolean(input.cdp && input.cdpExecutor);
  const instructions = buildInstructions(input.catalog, input.modelCatalog, cdpEnabled);
  const conversation = initConversationState(input.protocol, input.history, instructions);
  const model = input.model || AGENT_TEXT_MODEL_FALLBACK;
  const enableNativeWebSearch = Boolean(input.webSearch);

  let accumulated = '';
  // 跨轮累积的提案：模型常在同一轮里「边给商品 A 提案、边调用浏览器抓商品 B」，
  // 若只在收尾轮解析提案，早轮提案会被工具循环吃掉。
  const pendingProposals: AgentProposal[] = [];
  const pushProposals = (calls: CapturedToolCall[]) => {
    for (const item of calls
      .filter(call => call.name === PROPOSE_IMAGE_ACTION_TOOL.name)
      .map(call => parseProposalArguments(call.arguments))
      .filter((item): item is AgentProposal => item !== null)) {
      const duplicated = pendingProposals.some(other => (
        other.productKey === item.productKey
        && other.prompt === item.prompt
        && other.referencedImageIds.join(',') === item.referencedImageIds.join(',')
      ));
      if (!duplicated) pendingProposals.push(item);
    }
  };

  // 用户消息里的「N 张 + 比例」需求清单（如「2 张 1:1 + 5 张 3:4」或
  // 「一张 1:1 一张 3:4」）。模型可能漏掉其中某些比例（如只出 3:4 忘了 1:1）
  // ——代码层兜底补齐，克隆最近一份提案的 prompt/参考图，只改比例。
  // 已有提案的数量按用户明确说的张数纠正，上限 8。
  // 按从句/转折边界切分后再看否定；「能不能/可不可以/用不用/要不要」是正向能力问句。
  const RATIO_WORDS = '(?:1:1|3:4|9:16|16:9|2:3|3:2|4:5|5:4|4:3|1:4|4:1|1:8|8:1|21:9|正方形|竖版|竖屏|横版|横屏)';
  const CHINESE_COUNT_WORDS = '[零〇一二两三四五六七八九十百千万亿]+';
  const COUNT_TOKEN = `(?:\\d+|${CHINESE_COUNT_WORDS})`;
  const ABILITY_QUESTION_PATTERN = /能\s*不能|可\s*不可以|可以\s*不可以|用\s*不用|要\s*不要/g;
  const CLAUSE_SPLIT_PATTERN = /[，。；\n,、]|但/;
  const NEGATION_TOKEN_PATTERN = /不要|不用|禁止|严禁|避免|无需|无须|不能|不可|不需要|(?<![特分个差性级类识告区鉴派组离])别/g;
  const SEGMENT_RATIO_PATTERN = new RegExp(
    `每张\\s*(${RATIO_WORDS})|(${COUNT_TOKEN})\\s*张(?:(?!${COUNT_TOKEN}\\s*张).)*?(${RATIO_WORDS})|(${COUNT_TOKEN})\\s*张|(?:要|出|做|用|生成)\\s*(${RATIO_WORDS})`,
    'g',
  );
  const CHINESE_COUNT_DIGITS: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const CHINESE_COUNT_UNITS: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
    亿: 100000000,
  };
  const parseRequestedCount = (raw?: string): number => {
    const value = raw?.trim() || '';
    if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of value) {
      const digit = CHINESE_COUNT_DIGITS[char];
      if (digit !== undefined) {
        number = digit;
        continue;
      }
      const unit = CHINESE_COUNT_UNITS[char];
      if (unit === undefined) continue;
      if (unit < 10000) {
        section += (number || 1) * unit;
      } else {
        section = (section + number) || 1;
        total += section * unit;
        section = 0;
      }
      number = 0;
    }
    return total + section + number;
  };
  const isContinuationText = (text: string): boolean => /^(?:继续|再来|接着|下一个|下一张)[\s，,。.!！]*$/u.test(text.trim());
  const getRatioRequestText = (history: AgentMessage[]): string => {
    const userTexts = history.filter(message => message.role === 'user').map(message => message.text || '');
    const latest = userTexts[userTexts.length - 1] || '';
    if (!isContinuationText(latest)) return latest;
    return [...userTexts].reverse().find(text => !isContinuationText(text)) || '';
  };
  const extractRequestedRatios = (history: AgentMessage[]): { ratio: string; count: number }[] => {
    const requestText = getRatioRequestText(history)
      .replace(/：/g, ':')
      .replace(ABILITY_QUESTION_PATTERN, '');
    const items: { ratio: string; count: number }[] = [];
    const addItem = (raw: string | undefined, parsedCount: number) => {
      const ratio = canonicalizeAspectRatio(raw);
      if (!ratio || !Number.isFinite(parsedCount) || parsedCount < 1) return;
      const count = clampParallelCount(parsedCount);
      const existing = items.find(item => item.ratio === ratio);
      if (existing) existing.count = Math.max(existing.count, count);
      else items.push({ ratio, count });
    };
    let pendingEachCount: number | undefined;
    for (const clause of requestText.split(CLAUSE_SPLIT_PATTERN)) {
      if (!clause.trim()) continue;
      const segments: Array<{ text: string; negated: boolean }> = [];
      let cursor = 0;
      let negated = false;
      const negationRe = new RegExp(NEGATION_TOKEN_PATTERN.source, 'g');
      let negationMatch: RegExpExecArray | null;
      while ((negationMatch = negationRe.exec(clause)) !== null) {
        if (negationMatch.index > cursor) {
          segments.push({ text: clause.slice(cursor, negationMatch.index), negated });
        }
        negated = true;
        cursor = negationMatch.index + negationMatch[0].length;
      }
      if (cursor < clause.length || segments.length === 0) {
        segments.push({ text: clause.slice(cursor), negated });
      }
      for (const segment of segments) {
        if (!segment.text.trim()) continue;
        SEGMENT_RATIO_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SEGMENT_RATIO_PATTERN.exec(segment.text)) !== null) {
          if (match[1]) {
            if (!segment.negated) addItem(match[1], pendingEachCount ?? 1);
            continue;
          }
          if (match[2] && match[3]) {
            if (!segment.negated) addItem(match[3], parseRequestedCount(match[2]));
            continue;
          }
          if (match[4]) {
            const parsedCount = parseRequestedCount(match[4]);
            if (!segment.negated && Number.isFinite(parsedCount) && parsedCount >= 1) {
              pendingEachCount = clampParallelCount(parsedCount);
            }
            continue;
          }
          if (match[5] && !segment.negated) addItem(match[5], 1);
        }
      }
    }
    return items;
  };
  const hasMultipleSources = () => {
    const productKeys = new Set(pendingProposals.map(proposal => normalizeProductKey(proposal.productKey)).filter(Boolean));
    const productNames = new Set(pendingProposals.map(proposal => proposal.productName?.trim()).filter(Boolean));
    if (productKeys.size > 1 || productNames.size > 1) return true;
    return extractProductLinks(getRatioRequestText(input.history)).length > 1;
  };
  // ——多图分别处理兜底：用户点名「图1和图2都/分别处理」时，模型常只出一个提案、或把多张
  // 被修改图塞进同一提案，导致每次生成都拿到全部参考图（输出拼接/雷同）。这里把被点名的图
  // 拆成每图一个独立提案（refs 只含自己、count=1）。意图层由系统提示词教模型，这里是合同层兜底。
  const SEPARATE_CUE_PATTERN = /都|分别|各自|每张/;
  const MENTION_PATTERN = /图\s*(\d+)/g;
  const ensureSeparateImageEdits = () => {
    if (pendingProposals.length === 0) return;
    const requestText = getRatioRequestText(input.history);
    if (!requestText) return;
    const catalogIds = new Set(input.catalog.map(entry => entry.imgId));
    // 按子句收集被点名的图：同一子句要有「都/分别/各」类提示词，且该子句未被否定
    const mentioned: string[] = [];
    for (const clause of requestText.split(CLAUSE_SPLIT_PATTERN)) {
      if (!SEPARATE_CUE_PATTERN.test(clause)) continue;
      if (new RegExp(NEGATION_TOKEN_PATTERN.source).test(clause)) continue;
      MENTION_PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MENTION_PATTERN.exec(clause)) !== null) {
        const id = `img_${m[1]}`;
        if (catalogIds.has(id) && !mentioned.includes(id)) mentioned.push(id);
      }
    }
    if (mentioned.length < 2) return;
    const mentionedSet = new Set(mentioned);
    // 单参考图提案里的「图N」一律归一为「图1」；先折叠「图1和图2」这类连举，避免变成「图1和图1」
    const renumber = (prompt: string) => prompt
      .replace(/图\s*\d+(?:\s*[和与、,，]\s*图\s*\d+)+/g, '图1')
      .replace(/图\s*\d+/g, '图1');
    const singles = new Map<string, AgentProposal>();
    const passthrough: AgentProposal[] = [];
    for (const proposal of pendingProposals) {
      const hits = proposal.referencedImageIds.filter(id => mentionedSet.has(id));
      if (proposal.action === 'edit' && hits.length >= 2) {
        // 多张被点名图塞进同一提案 → 拆成每图一个独立提案
        for (const id of hits) {
          if (!singles.has(id)) {
            singles.set(id, {
              ...proposal,
              referencedImageIds: [id],
              parallelCount: 1,
              prompt: renumber(proposal.prompt),
            });
          }
        }
      } else if (proposal.action === 'edit' && proposal.referencedImageIds.length === 1 && hits.length === 1) {
        if (!singles.has(hits[0])) singles.set(hits[0], proposal);
      } else {
        passthrough.push(proposal);
      }
    }
    if (singles.size === 0) return; // 模型完全没为被点名图出 edit 提案，不凭空发明
    const template = singles.get(mentioned.find(id => singles.has(id)) as string) as AgentProposal;
    // 按用户点名顺序输出；被点名但无提案覆盖的图，克隆单参考图提案补齐
    const ordered: AgentProposal[] = [];
    for (const id of mentioned) {
      const existing = singles.get(id);
      if (existing) {
        ordered.push(existing);
      } else {
        ordered.push({
          ...template,
          referencedImageIds: [id],
          parallelCount: 1,
          prompt: renumber(template.prompt),
          reason: `补足用户点名处理的 ${id}`,
        });
      }
    }
    pendingProposals.splice(0, pendingProposals.length, ...passthrough, ...ordered);
  };
  const ensureRequestedRatios = () => {
    const required = extractRequestedRatios(input.history);
    if (required.length === 0 || pendingProposals.length === 0) return;
    for (const proposal of pendingProposals) {
      const canonical = canonicalizeAspectRatio(proposal.requestedAspectRatio);
      if (canonical) proposal.requestedAspectRatio = canonical;
      const wanted = required.find(item => item.ratio === canonical);
      if (wanted) proposal.parallelCount = wanted.count;
    }
    if (hasMultipleSources()) return;
    const existing = new Set(pendingProposals.map(p => p.requestedAspectRatio).filter(Boolean));
    const missing = required.filter(item => !existing.has(item.ratio));
    if (missing.length === 0) return;
    const base = pendingProposals[pendingProposals.length - 1];
    for (const { ratio, count } of missing) {
      // 只按用户明确说的数量补，禁止克隆 base 的 parallel_count（否则「2 张 1:1 +
      // 5 张 3:4」模型只提 3:4 时会补出 5 张 1:1，超量生成）。
      // prompt 保持模型原文：比例只走参数。仅当模型自己写了 base 比例文字时替换成新比例，不自造。
      const baseRatio = base.requestedAspectRatio?.trim();
      const prompt = baseRatio && base.prompt.includes(baseRatio)
        ? base.prompt.split(baseRatio).join(ratio)
        : base.prompt;
      pendingProposals.push({
        ...base,
        prompt,
        requestedAspectRatio: ratio,
        parallelCount: count,
        reason: `补足用户要求的 ${count} 张 ${ratio} 比例`,
      });
    }
  };
  if (cdpEnabled) {
    callbacks.onToolActivity?.('正在连接模型，准备调用浏览器工具…\n');
  }
  for (let round = 0; ; round++) {
    if (signal.aborted) return;
    const body = buildAgentRequestBody(input.protocol, model, conversation, instructions, enableNativeWebSearch, cdpEnabled);
    // 超时/网络错误只重试当前模型流，不重跑已经执行过的浏览器工具。
    const roundResult = await runAgentRequestWithRetry(
      (attemptSignal, resetIdle) => streamAgentRound(baseUrl, input, body, callbacks, attemptSignal, resetIdle),
      signal,
      AGENT_CHAT_ATTEMPT_TIMEOUT_MS,
      {
        idle: true,
        onRetry: callbacks.onRetry,
        onResetAttempt: callbacks.onResetAttempt,
      },
    );

    // 跨轮文本拼接：中间轮的过渡语（如「我先打开这个链接看看」）与最终答复都展示
    if (round > 0 && accumulated.length > 0 && roundResult.text.length > 0) {
      accumulated += '\n\n';
      callbacks.onDelta('\n\n');
    }
    accumulated += roundResult.text;

    const cdpCalls = cdpEnabled ? roundResult.toolCalls.filter(call => isAgentCdpTool(call.name)) : [];

    // 同一轮里既读页面又提案时，必须先执行浏览器工具；否则提案是空的，页面也没打开。
    // 提案本身不丢：先累积，待工具循环收尾后统一交给调用方排队。
    pushProposals(roundResult.toolCalls);
    if (cdpCalls.length > 0 && round < AGENT_CDP_MAX_TOOL_ROUNDS - 1) {
      const exchanges: Array<{ call: CapturedToolCall; result: string }> = [];
      for (const call of cdpCalls) {
        if (signal.aborted) return;
        callbacks.onToolActivity?.(`\n[调用浏览器工具] ${normalizeCdpToolName(call.name)}\n`);
        const result = await executeCdpCall(input.cdpExecutor!, call, callbacks.onToolActivity);
        exchanges.push({ call, result });
        if (result.trim()) {
          accumulated += `\n\n${result.trim()}`;
          callbacks.onDelta(`\n\n${result.trim()}`);
        }
      }
      appendToolExchange(conversation, exchanges, roundResult.text);
      continue;
    }

    if (pendingProposals.length > 0) {
      ensureSeparateImageEdits();
      ensureRequestedRatios();
      callbacks.onDone(accumulated, pendingProposals[0], pendingProposals);
      return;
    }
    const fallbackArgs = roundResult.toolCalls.length > 0
      ? roundResult.toolCalls[roundResult.toolCalls.length - 1].arguments
      : '';
    callbacks.onDone(accumulated, parseProposalArguments(fallbackArgs));
    return;
  }
}

/** 单轮流式请求：发出 body，解析 SSE，返回本轮文本与完整工具调用列表 */
async function streamAgentRound(
  baseUrl: string,
  input: StreamAgentInput,
  body: Record<string, unknown>,
  callbacks: StreamAgentCallbacks,
  signal: AbortSignal,
  resetIdle?: () => void,
): Promise<RoundResult> {
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
  const toolCalls = new Map<string, CapturedToolCall>();
  const streamState = {
    get accumulated() { return accumulated; },
    setAccumulated: (next: string) => { accumulated = next; },
    toolCalls,
    hasDeltaReasoning: false,
  };

  await readSseStream(response.body, signal, (event) => {
    resetIdle?.();
    if (!event.data) return;
    if (event.data === '[DONE]') {
      return;
    }

    let payload: ResponsesEventEnvelope | ChatCompletionsEventEnvelope | MessagesEventEnvelope | Record<string, unknown>;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    handleAgentStreamEvent(input.protocol, payload, event.event || '', callbacks, streamState);
  });

  return {
    text: accumulated,
    toolCalls: [...toolCalls.values()].filter(call => call.name.length > 0),
  };
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
  conversation: ConversationState,
  instructions: string,
  enableNativeWebSearch: boolean,
  enableCdpTools: boolean,
) {
  const cdpTools = enableCdpTools ? AGENT_CDP_TOOLS : [];

  if (protocol === 'openai-chat-completions') {
    return {
      model,
      stream: true,
      messages: conversation.kind === 'chat' ? conversation.messages : [],
      tools: [
        {
          type: 'function' as const,
          function: {
            name: PROPOSE_IMAGE_ACTION_TOOL.name,
            description: PROPOSE_IMAGE_ACTION_TOOL.description,
            parameters: PROPOSE_IMAGE_ACTION_TOOL.parameters,
          },
        },
        ...cdpTools.map(tool => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
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
      thinking: {
        type: 'adaptive' as const,
        display: 'summarized' as const,
      },
      output_config: {
        effort: 'high' as const,
      },
      messages: conversation.kind === 'anthropic' ? conversation.messages : [],
      tools: [
        {
          name: PROPOSE_IMAGE_ACTION_TOOL.name,
          description: PROPOSE_IMAGE_ACTION_TOOL.description,
          input_schema: PROPOSE_IMAGE_ACTION_TOOL.parameters,
        },
        ...cdpTools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        ...(enableNativeWebSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : []),
      ],
    };
  }

  if (protocol === 'google-gemini') {
    return {
      contents: conversation.kind === 'gemini' ? conversation.contents : [],
      tools: [
        {
          function_declarations: [
            {
              name: PROPOSE_IMAGE_ACTION_TOOL.name,
              description: PROPOSE_IMAGE_ACTION_TOOL.description,
              parameters: PROPOSE_IMAGE_ACTION_TOOL.parameters,
            },
            ...cdpTools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
          ],
        },
        ...(enableNativeWebSearch ? [{ google_search: {} }] : []),
      ],
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: -1,
          includeThoughts: true,
        },
      },
    };
  }

  return {
    model,
    stream: true,
    reasoning: { effort: 'medium' as const, summary: 'detailed' as const },
    instructions,
    tools: [
      PROPOSE_IMAGE_ACTION_TOOL,
      ...cdpTools.map(tool => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      ...(enableNativeWebSearch ? [{ type: 'web_search' as const }] : []),
    ],
    tool_choice: 'auto' as const,
    input: conversation.kind === 'responses' ? conversation.input : [],
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
    toolCalls: Map<string, CapturedToolCall>;
    hasDeltaReasoning?: boolean;
  },
) {
  if (protocol === 'openai-chat-completions') {
    const chunk = payload as ChatCompletionsEventEnvelope;
    if (rawEventType === 'error' || chunk.error?.message) {
      throw new Error(chunk.error?.message || chunk.message || '模型返回错误');
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const reasoningDelta = [
      choice.delta?.reasoning_content,
      choice.delta?.reasoning,
      choice.delta?.reasoning_text,
    ].find(value => typeof value === 'string' && value.length > 0);
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      state.hasDeltaReasoning = true;
      callbacks.onReasoning(reasoningDelta);
    }

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

    // 流式工具调用：首个 chunk 带 id/name，后续 chunk 只拼 arguments 片段
    for (const toolCall of choice.delta?.tool_calls || []) {
      const key = String(typeof toolCall.index === 'number' ? toolCall.index : 0);
      const draft = state.toolCalls.get(key) || { id: '', name: '', arguments: '' };
      if (typeof toolCall.id === 'string' && toolCall.id.length > 0) draft.id = toolCall.id;
      if (typeof toolCall.function?.name === 'string' && toolCall.function.name.length > 0) draft.name = toolCall.function.name;
      if (typeof toolCall.function?.arguments === 'string') draft.arguments += toolCall.function.arguments;
      state.toolCalls.set(key, draft);
    }

    const reasoningFull = [
      choice.message?.reasoning_content,
      choice.message?.reasoning,
      choice.message?.reasoning_text,
    ].find(value => typeof value === 'string' && value.length > 0);
    // 仅在流式未接收过增量 reasoning 时才输出，避免尾包全量 reasoning 重复追加
    if (!state.hasDeltaReasoning && typeof reasoningFull === 'string' && reasoningFull.length > 0) {
      state.hasDeltaReasoning = true;
      callbacks.onReasoning(reasoningFull);
    }

    // 非流式兜底：完整 message 里带完整 tool_calls
    for (const toolCall of choice.message?.tool_calls || []) {
      const name = typeof toolCall.function?.name === 'string' ? toolCall.function.name : '';
      const args = typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : '';
      if (!name && !args) continue;
      state.toolCalls.set(`msg_${state.toolCalls.size}`, {
        id: typeof toolCall.id === 'string' ? toolCall.id : '',
        name,
        arguments: args,
      });
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
      if (chunk.content_block?.type === 'thinking' && typeof chunk.content_block.text === 'string' && chunk.content_block.text.length > 0) {
        callbacks.onReasoning(chunk.content_block.text);
      }
      if (chunk.content_block?.type === 'tool_use' && typeof chunk.index === 'number') {
        const input = chunk.content_block.input;
        state.toolCalls.set(String(chunk.index), {
          id: typeof chunk.content_block.id === 'string' ? chunk.content_block.id : '',
          name: typeof chunk.content_block.name === 'string' ? chunk.content_block.name : '',
          arguments: input && typeof input === 'object' && Object.keys(input as Record<string, unknown>).length > 0
            ? JSON.stringify(input)
            : '',
        });
      }
      return;
    }
    if (eventType === 'content_block_delta') {
      if (chunk.delta?.type === 'thinking_delta' && typeof chunk.delta?.thinking === 'string') {
        callbacks.onReasoning(chunk.delta.thinking);
      }
      if (typeof chunk.delta?.text === 'string') {
        state.setAccumulated(state.accumulated + chunk.delta.text);
        callbacks.onDelta(chunk.delta.text);
      }
      if (typeof chunk.delta?.partial_json === 'string') {
        const key = String(typeof chunk.index === 'number' ? chunk.index : 0);
        const draft = state.toolCalls.get(key) || { id: '', name: '', arguments: '' };
        draft.arguments += chunk.delta.partial_json;
        state.toolCalls.set(key, draft);
      }
      return;
    }
    if (eventType === 'message_stop') {
      // 非流式兜底：完整 message 里带 tool_use 且流式过程未捕获到时补齐
      if (state.toolCalls.size === 0) {
        for (const part of chunk.message?.content || []) {
          if (part.type !== 'tool_use' || !part.input) continue;
          state.toolCalls.set(`stop_${state.toolCalls.size}`, {
            id: typeof part.id === 'string' ? part.id : '',
            name: typeof part.name === 'string' ? part.name : '',
            arguments: JSON.stringify(part.input),
          });
        }
      }
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
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (part.thought === true) {
            callbacks.onReasoning(part.text);
          } else {
            state.setAccumulated(state.accumulated + part.text);
            callbacks.onDelta(part.text);
          }
        }
        if (part.functionCall?.name) {
          const args = JSON.stringify(part.functionCall.args || {});
          // gemini 的 functionCall 一次性完整下发；按 name+args 去重防止重复 chunk
          const duplicated = [...state.toolCalls.values()].some(call => call.name === part.functionCall!.name && call.arguments === args);
          if (!duplicated) {
            state.toolCalls.set(`fn_${state.toolCalls.size}`, {
              id: part.functionCall.name,
              name: part.functionCall.name,
              arguments: args,
            });
          }
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
  // responses 协议的工具调用：output_item.added 带 id/name，arguments 经 delta/done 拼装；
  // 这些事件都带 output_index，用它对齐同一次调用
  const responsesToolKey = (item?: { id?: string; call_id?: string }) =>
    typeof chunk.output_index === 'number'
      ? `out_${chunk.output_index}`
      : chunk.item_id || item?.call_id || item?.id || `auto_${state.toolCalls.size}`;
  if (eventType === 'response.output_item.added') {
    const item = chunk.item;
    if (item?.type === 'function_call') {
      state.toolCalls.set(responsesToolKey(item), {
        id: item.call_id || item.id || '',
        name: item.name || '',
        arguments: typeof item.arguments === 'string' ? item.arguments : '',
      });
    }
    return;
  }
  if (eventType === 'response.function_call_arguments.delta') {
    if (typeof chunk.delta === 'string') {
      const key = responsesToolKey();
      const draft = state.toolCalls.get(key) || { id: '', name: '', arguments: '' };
      draft.arguments += chunk.delta;
      state.toolCalls.set(key, draft);
    }
    return;
  }
  if (eventType === 'response.function_call_arguments.done') {
    if (typeof chunk.arguments === 'string' && chunk.arguments.length > 0) {
      const key = responsesToolKey();
      const draft = state.toolCalls.get(key) || { id: '', name: '', arguments: '' };
      draft.arguments = chunk.arguments;
      state.toolCalls.set(key, draft);
    }
    return;
  }
  if (eventType === 'response.output_item.done') {
    const item = chunk.item;
    if (item?.type === 'function_call') {
      const key = responsesToolKey(item);
      const draft = state.toolCalls.get(key) || { id: '', name: '', arguments: '' };
      draft.id = item.call_id || item.id || draft.id;
      draft.name = item.name || draft.name;
      if (typeof item.arguments === 'string' && item.arguments.length > 0) draft.arguments = item.arguments;
      state.toolCalls.set(key, draft);
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
    // 兜底：completed 里的完整 output 补齐流式过程中漏掉的调用
    for (const item of chunk.response?.output || []) {
      if (item.type !== 'function_call') continue;
      const id = item.call_id || item.id || '';
      const existingKey = [...state.toolCalls.entries()].find(([, call]) =>
        (id && call.id === id) || (item.name && call.name === item.name),
      )?.[0];
      const draft = existingKey !== undefined
        ? state.toolCalls.get(existingKey)!
        : { id: '', name: '', arguments: '' };
      draft.id = id || draft.id;
      draft.name = item.name || draft.name;
      if (typeof item.arguments === 'string' && item.arguments.length > 0) draft.arguments = item.arguments;
      state.toolCalls.set(existingKey ?? `done_${state.toolCalls.size}`, draft);
    }
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

type AgentAttemptRequest<T> = (signal: AbortSignal, resetIdle: () => void) => Promise<T>;

async function runAttemptWithTimeout<T>(
  request: AgentAttemptRequest<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  idle = false,
): Promise<T> {
  const attempt = createAttemptSignal(parentSignal);
  const timeoutError = new AgentRequestTimeoutError(timeoutMs);
  let timeoutId: number | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const armTimeout = () => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      if (!attempt.signal.aborted) attempt.abort(timeoutError);
      rejectTimeout?.(timeoutError);
    }, timeoutMs);
  };
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    armTimeout();
  });
  try {
    return await Promise.race([request(attempt.signal, idle ? armTimeout : () => undefined), timeoutPromise]);
  } catch (err) {
    if (attempt.signal.reason instanceof AgentRequestTimeoutError || err instanceof AgentRequestTimeoutError) {
      throw timeoutError;
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    attempt.cleanup();
  }
}

async function runAgentRequestWithRetry<T>(
  request: AgentAttemptRequest<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  retryHooks?: Pick<StreamAgentCallbacks, 'onRetry' | 'onResetAttempt'> & { idle?: boolean },
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= AGENT_GPT_REQUEST_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    try {
      return await runAttemptWithTimeout(request, signal, timeoutMs, retryHooks?.idle === true);
    } catch (err) {
      if (signal?.aborted) throw err;
      const normalized = normalizeStreamError(err);
      lastError = normalized;
      if (attempt >= AGENT_GPT_REQUEST_MAX_ATTEMPTS || !isRetryableAgentError(err)) {
        throw normalized;
      }
      retryHooks?.onResetAttempt?.();
      retryHooks?.onRetry?.(attempt + 1, AGENT_GPT_REQUEST_MAX_ATTEMPTS, normalized);
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
