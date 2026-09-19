import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  describeImage,
  streamAgentChat,
  type StreamAgentCallbacks,
  type StreamAgentInput,
} from '@/lib/agent-chat-client';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

// ===== SSE 构造辅助 =====

function dataFrame(payload: unknown, event?: string): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `${event ? `event: ${event}\n` : ''}data: ${data}\n\n`;
}

function sseResponse(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 各协议「纯文本一句话然后结束」的收尾流 */
function finalTextFrames(protocol: TextProviderProtocol, text: string): string[] {
  if (protocol === 'openai-chat-completions') {
    return [
      dataFrame({ choices: [{ delta: { content: text } }] }),
      dataFrame('[DONE]'),
    ];
  }
  if (protocol === 'anthropic-messages') {
    return [
      dataFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      dataFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      dataFrame({ type: 'message_stop' }),
    ];
  }
  if (protocol === 'google-gemini') {
    return [dataFrame({ candidates: [{ content: { parts: [{ text }] } }] })];
  }
  return [
    dataFrame({ type: 'response.output_text.delta', delta: text }),
    dataFrame({ type: 'response.completed', response: { output_text: text, output: [] } }),
  ];
}

/** 各协议「调用一次指定工具然后结束」的流 */
function toolCallFrames(protocol: TextProviderProtocol, name: string, args: Record<string, unknown>, id: string): string[] {
  const argsJson = JSON.stringify(args);
  if (protocol === 'openai-chat-completions') {
    return [
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] } }] }),
      dataFrame('[DONE]'),
    ];
  }
  if (protocol === 'anthropic-messages') {
    return [
      dataFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } }),
      dataFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: argsJson } }),
      dataFrame({ type: 'message_stop' }),
    ];
  }
  if (protocol === 'google-gemini') {
    return [dataFrame({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] })];
  }
  return [
    dataFrame({ type: 'response.output_item.added', output_index: 1, item: { id: `item_${id}`, call_id: id, type: 'function_call', name, arguments: '' } }),
    dataFrame({ type: 'response.function_call_arguments.done', output_index: 1, item_id: `item_${id}`, arguments: argsJson }),
    dataFrame({ type: 'response.completed', response: { output_text: '', output: [{ type: 'function_call', id: `item_${id}`, call_id: id, name, arguments: argsJson }] } }),
  ];
}

// ===== 测试辅助 =====

function baseInput(protocol: TextProviderProtocol, extra?: Partial<StreamAgentInput>): StreamAgentInput {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    protocol,
    history: [{ id: 'u1', role: 'user', text: '帮我看看这个链接', createdAt: 1 }],
    catalog: [],
    modelCatalog: [],
    ...extra,
  };
}

interface Collected {
  deltas: string[];
  toolActivity: string[];
  done: { text: string; proposal: { prompt?: string } | null; proposals?: Array<{ prompt?: string }> } | null;
  error: Error | null;
}

function makeCallbacks(): { callbacks: StreamAgentCallbacks; collected: Collected } {
  const collected: Collected = { deltas: [], toolActivity: [], done: null, error: null };
  const callbacks: StreamAgentCallbacks = {
    onDelta: token => collected.deltas.push(token),
    onReasoning: () => undefined,
    onToolActivity: text => collected.toolActivity.push(text),
    onDone: ((text, proposal, proposals) => { collected.done = { text, proposal, proposals }; }) as StreamAgentCallbacks['onDone'],
    onError: err => { collected.error = err; },
  };
  return { callbacks, collected };
}

async function runUserProposalCase(userText: string, modelProposals: Array<Record<string, unknown>>) {
  const mock = vi.fn().mockResolvedValue(sseResponse([
    dataFrame({
      choices: [{
        delta: {
          tool_calls: modelProposals.map((proposal, index) => ({
            index,
            id: `call_${index}`,
            function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) },
          })),
        },
      }],
    }),
    dataFrame('[DONE]'),
  ]));
  vi.stubGlobal('fetch', mock);
  const { callbacks, collected } = makeCallbacks();
  await streamAgentChat(baseInput('openai-chat-completions', {
    history: [{ id: 'ratio-case', role: 'user', text: userText, createdAt: 1 }],
  }), callbacks).promise;
  return collected;
}

function baseGenerateProposal(overrides: Record<string, unknown> = {}) {
  return {
    action: 'generate',
    prompt: '主图，画面比例 3:4',
    requested_aspect_ratio: '3:4',
    parallel_count: 1,
    referenced_image_ids: ['img_a'],
    reason: '3:4 方案',
    ...overrides,
  };
}

function requestBodyOf(mock: Mock, callIndex: number): Record<string, unknown> {
  const [, init] = mock.mock.calls[callIndex] as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { requestBody: Record<string, unknown> }).requestBody;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALL_PROTOCOLS: TextProviderProtocol[] = [
  'openai-chat-completions',
  'anthropic-messages',
  'google-gemini',
  'openai-responses',
];

describe('buildAgentRequestBody 的 CDP 工具声明', () => {
  it.each(ALL_PROTOCOLS)('%s：cdp 开启时声明浏览器工具', async protocol => {
    const mock = vi.fn().mockResolvedValue(sseResponse(finalTextFrames(protocol, '好的')));
    vi.stubGlobal('fetch', mock);
    const { callbacks } = makeCallbacks();

    await streamAgentChat(baseInput(protocol, { cdp: true, cdpExecutor: async () => 'ok' }), callbacks).promise;

    const body = requestBodyOf(mock, 0);
    const tools = (body.tools || []) as Array<Record<string, unknown>>;
    let names: string[] = [];
    if (protocol === 'openai-chat-completions') {
      names = tools.map(t => (t.function as { name: string }).name);
    } else if (protocol === 'google-gemini') {
      names = ((tools[0].function_declarations || []) as Array<{ name: string }>).map(t => t.name);
    } else {
      names = tools.map(t => t.name as string);
    }
    for (const toolName of ['browser_status', 'browser_set_port', 'browser_list_tabs', 'browser_open_url', 'browser_read_page', 'browser_read_taobao', 'browser_save_images']) {
      expect(names).toContain(toolName);
    }
  });

  it('openai chat-completions 默认不发送 reasoning_effort', async () => {
    const mock = vi.fn().mockResolvedValue(sseResponse(finalTextFrames('openai-chat-completions', '好的')));
    vi.stubGlobal('fetch', mock);
    const { callbacks } = makeCallbacks();

    await streamAgentChat(baseInput('openai-chat-completions'), callbacks).promise;

    expect(requestBodyOf(mock, 0)).not.toHaveProperty('reasoning_effort');
  });

  it('openai chat-completions 流式包含 delta reasoning 与尾包全量 reasoning 时不重复输出', async () => {
    const frames = [
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '思考第一步' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '思考第二步' } }] }) + '\n\n',
      'data: ' + JSON.stringify({
        choices: [{
          delta: { content: '最终正文' },
          message: { role: 'assistant', content: '最终正文', reasoning_content: '思考第一步思考第二步' },
        }],
      }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    const mock = vi.fn().mockResolvedValue(sseResponse(frames));
    vi.stubGlobal('fetch', mock);
    const reasoningTokens: string[] = [];
    const { callbacks } = makeCallbacks();
    callbacks.onReasoning = (token: string) => reasoningTokens.push(token);

    await streamAgentChat(baseInput('openai-chat-completions'), callbacks).promise;

    expect(reasoningTokens.join('')).toBe('思考第一步思考第二步');
  });
});


describe('CDP 工具循环', () => {
  it.each(ALL_PROTOCOLS)('%s：工具调用执行后按协议原生格式回灌并继续', async protocol => {
    const executor = vi.fn(async () => '工具执行结果文本');
    const mock = vi.fn()
      .mockResolvedValueOnce(sseResponse(toolCallFrames(protocol, 'browser_open_url', { url: 'https://item.taobao.com/item.htm?id=1' }, 'call_1')))
      .mockResolvedValueOnce(sseResponse(finalTextFrames(protocol, '已打开页面')));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();

    await streamAgentChat(baseInput(protocol, { cdp: true, cdpExecutor: executor }), callbacks).promise;

    expect(collected.error).toBeNull();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('browser_open_url', { url: 'https://item.taobao.com/item.htm?id=1' }, expect.any(Function));
    expect(collected.toolActivity.some(text => text.includes('browser_open_url'))).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(collected.done?.proposal).toBeNull();
    expect(collected.done?.text).toContain('工具执行结果文本');
    expect(collected.done?.text).toContain('已打开页面');

    // 第二轮请求体必须包含协议原生的工具调用与结果回灌
    const body = requestBodyOf(mock, 1);
    if (protocol === 'openai-chat-completions') {
      const messages = body.messages as Array<Record<string, unknown>>;
      const assistantToolMsg = messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
      expect(assistantToolMsg).toBeTruthy();
      const toolCalls = assistantToolMsg!.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
      expect(toolCalls[0].function.name).toBe('browser_open_url');
      const toolMsg = messages.find(m => m.role === 'tool');
      expect(toolMsg).toMatchObject({ tool_call_id: 'call_1', content: '工具执行结果文本' });
    } else if (protocol === 'anthropic-messages') {
      const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      const assistantToolMsg = messages.find(m => m.role === 'assistant' && m.content.some(p => p.type === 'tool_use'));
      expect(assistantToolMsg).toBeTruthy();
      const userToolMsg = messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'tool_result'));
      expect(userToolMsg).toBeTruthy();
      expect(userToolMsg!.content.find(p => p.type === 'tool_result')).toMatchObject({ tool_use_id: 'call_1', content: '工具执行结果文本' });
    } else if (protocol === 'google-gemini') {
      const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      const modelMsg = contents.find(c => c.role === 'model' && c.parts.some(p => p.functionCall));
      expect(modelMsg).toBeTruthy();
      const userMsg = contents.find(c => c.role === 'user' && c.parts.some(p => p.functionResponse));
      expect(userMsg).toBeTruthy();
      const fr = userMsg!.parts.find(p => p.functionResponse)!.functionResponse as { name: string; response: { result: string } };
      expect(fr.name).toBe('browser_open_url');
      expect(fr.response.result).toBe('工具执行结果文本');
    } else {
      const input = body.input as Array<Record<string, unknown>>;
      const call = input.find(item => item.type === 'function_call');
      expect(call).toMatchObject({ call_id: 'call_1', name: 'browser_open_url' });
      const output = input.find(item => item.type === 'function_call_output');
      expect(output).toMatchObject({ call_id: 'call_1', output: '工具执行结果文本' });
    }
  });

  it('模型调用 propose_image_action 时直接产出提案，不执行 CDP 工具', async () => {
    const executor = vi.fn(async () => '不应被调用');
    const proposalArgs = {
      action: 'generate',
      prompt: '画一张淘宝主图',
      referenced_image_ids: [],
      reason: '用户要做主图',
    };
    const mock = vi.fn().mockResolvedValue(
      sseResponse(toolCallFrames('openai-chat-completions', 'propose_image_action', proposalArgs, 'call_p')),
    );
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();

    await streamAgentChat(baseInput('openai-chat-completions', { cdp: true, cdpExecutor: executor }), callbacks).promise;

    expect(executor).not.toHaveBeenCalled();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(collected.done?.proposal?.prompt).toBe('画一张淘宝主图');
  });

  it('同一轮返回多个不同商品提案时按顺序交给调用方排队', async () => {
    const first = {
      action: 'generate',
      prompt: '商品 A 的宣传图（1:1）',
      requested_aspect_ratio: '1:1',
      referenced_image_ids: ['img_a'],
      reason: '商品 A',
      product_key: 'https://item.taobao.com/item.htm?id=1',
      product_name: '商品 A',
    };
    const second = {
      action: 'generate',
      prompt: '商品 B 的宣传图（3:4）',
      requested_aspect_ratio: '3:4',
      referenced_image_ids: ['img_b'],
      reason: '商品 B',
      product_key: 'https://item.taobao.com/item.htm?id=2',
      product_name: '商品 B',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'propose_image_action', arguments: JSON.stringify(first) } }, { index: 1, id: 'call_b', function: { name: 'propose_image_action', arguments: JSON.stringify(second) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();

    await streamAgentChat(baseInput('openai-chat-completions'), callbacks).promise;

    expect(collected.error).toBeNull();
    expect(collected.done?.proposal?.prompt).toBe('商品 A 的宣传图（1:1）');
    expect(collected.done?.proposals?.map(item => item.prompt)).toEqual(['商品 A 的宣传图（1:1）', '商品 B 的宣传图（3:4）']);
    expect(collected.done?.proposals?.map(item => item.requestedAspectRatio)).toEqual(['1:1', '3:4']);
    expect(collected.done?.proposals?.map(item => item.productKey)).toEqual([
      'https://item.taobao.com/item.htm?id=1',
      'https://item.taobao.com/item.htm?id=2',
    ]);
    expect(collected.done?.proposals?.map(item => item.referencedImageIds.join(','))).toEqual(['img_a', 'img_b']);
  });

  it('模型只提 3:4 时按用户「2 张 1:1 + 5 张 3:4」自动补齐 1:1 提案', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝美妆电商主图，以图1为主体',
      requested_aspect_ratio: '3:4',
      referenced_image_ids: ['img_a'],
      reason: '5 张 3:4',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_z', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'u2', role: 'user', text: '生成 2 张 1:1 比例的淘宝主图，以及 5 张 3:4 比例的淘宝主图', createdAt: 2 }],
    });

    await streamAgentChat(input, callbacks).promise;

    expect(collected.error).toBeNull();
    const proposals = collected.done?.proposals || [];
    const ratios = proposals.map(item => item.requestedAspectRatio);
    expect(ratios).toContain('3:4');
    expect(ratios).toContain('1:1');
    expect(ratios.length).toBe(2);
    // 补齐的 1:1 提案：数量按用户说的 2 张（不是克隆 base 的 5），参考图沿用 base；
    // prompt 保持模型原文，比例只走 requestedAspectRatio 参数，不往文本里塞
    const filled = proposals.find(item => item.requestedAspectRatio === '1:1');
    expect(filled).toBeTruthy();
    expect(filled!.parallelCount).toBe(2);
    expect(filled!.referencedImageIds).toEqual(['img_a']);
    expect(filled!.prompt).not.toContain('画面比例');
    expect(filled!.prompt).not.toContain('3:4');
    expect(filled!.prompt).not.toContain('1:1');
  });

  it('「做 2 张，一张 1:1 一张 3:4」且模型只出 1:1 时自动补齐 3:4', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图',
      requested_aspect_ratio: '1:1',
      referenced_image_ids: ['img_a'],
      reason: '1:1',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_w', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'u3', role: 'user', text: '做 2 张，一张 1:1 一张 3:4 的淘宝主图', createdAt: 3 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const proposals = collected.done?.proposals || [];
    const ratios = proposals.map(item => item.requestedAspectRatio);
    expect(ratios).toContain('1:1');
    expect(ratios).toContain('3:4');
    // 「一张 3:4」补齐提案：数量=1，base prompt 里的 1:1 文字不会被错误保留
    const filled = proposals.find(item => item.requestedAspectRatio === '3:4');
    expect(filled).toBeTruthy();
    expect(filled!.parallelCount).toBe(1);
    expect(filled!.referencedImageIds).toEqual(['img_a']);
  });

  it('否定句中的比例不补齐：「不要 2 张 1:1，只要 3 张 3:4」只保留 3:4 提案', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 3,
      referenced_image_ids: ['img_a'],
      reason: '3 张 3:4',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_neg', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'u4', role: 'user', text: '不要出 2 张 1:1，只要 3 张 3:4 的主图', createdAt: 4 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const proposals = collected.done?.proposals || [];
    expect(proposals.length).toBe(1);
    expect(proposals[0].requestedAspectRatio).toBe('3:4');
    expect(proposals[0].parallelCount).toBe(3);
  });

  it('方向词按 system 指令映射：「一张横版一张竖版」模型已给 16:9/9:16 时不再重复补提案', async () => {
    const wide = {
      action: 'generate',
      prompt: '淘宝主图横版',
      requested_aspect_ratio: '16:9',
      referenced_image_ids: ['img_a'],
      reason: '横版',
    };
    const tall = {
      action: 'generate',
      prompt: '淘宝主图竖版',
      requested_aspect_ratio: '9:16',
      referenced_image_ids: ['img_a'],
      reason: '竖版',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_wide', function: { name: 'propose_image_action', arguments: JSON.stringify(wide) } },
        { index: 1, id: 'call_tall', function: { name: 'propose_image_action', arguments: JSON.stringify(tall) } },
      ] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'u5', role: 'user', text: '做一张横版一张竖版的淘宝主图', createdAt: 5 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['16:9', '9:16']);
  });

  it('多来源提案缺比例时不跨商品克隆补齐', async () => {
    const proposalA = {
      action: 'generate',
      prompt: '商品 A 主图',
      requested_aspect_ratio: '1:1',
      referenced_image_ids: ['img_a'],
      reason: '商品 A',
      product_key: 'https://item.taobao.com/item.htm?id=1',
      product_name: '商品 A',
    };
    const proposalB = {
      action: 'generate',
      prompt: '商品 B 主图',
      requested_aspect_ratio: '3:4',
      referenced_image_ids: ['img_b'],
      reason: '商品 B',
      product_key: 'https://item.taobao.com/item.htm?id=2',
      product_name: '商品 B',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_source_a', function: { name: 'propose_image_action', arguments: JSON.stringify(proposalA) } },
        { index: 1, id: 'call_source_b', function: { name: 'propose_image_action', arguments: JSON.stringify(proposalB) } },
      ] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{
        id: 'multi-source',
        role: 'user',
        text: '商品 A https://item.taobao.com/item.htm?id=1 做 1 张 1:1；商品 B https://item.taobao.com/item.htm?id=2 做 1 张 3:4 和 1 张 9:16',
        createdAt: 6,
      }],
    });

    await streamAgentChat(input, callbacks).promise;

    expect(collected.error).toBeNull();
    expect(collected.done?.proposals?.map(item => item.requestedAspectRatio)).toEqual(['1:1', '3:4']);
  });

  it('「能不能出 2 张 1:1」中的不能不是否定需求', async () => {
    const proposal = {
      action: 'generate',
      prompt: '主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 1,
      referenced_image_ids: [],
      reason: '先给 3:4 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_can', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'can', role: 'user', text: '能不能出 2 张 1:1 的主图', createdAt: 7 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const oneToOne = collected.done?.proposals?.find(item => item.requestedAspectRatio === '1:1');
    expect(oneToOne).toBeTruthy();
    expect(oneToOne!.parallelCount).toBe(2);
  });

  it('识别中文数量「三张 3:4」并把数量带入补齐提案', async () => {
    const proposal = {
      action: 'generate',
      prompt: '主图，画面比例 1:1',
      requested_aspect_ratio: '1:1',
      parallel_count: 1,
      referenced_image_ids: [],
      reason: '先给 1:1 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_chinese_count', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'chinese-count', role: 'user', text: '生成三张 3:4 的主图', createdAt: 8 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const threeToFour = collected.done?.proposals?.find(item => item.requestedAspectRatio === '3:4');
    expect(threeToFour).toBeTruthy();
    expect(threeToFour!.parallelCount).toBe(3);
  });

  it('用户说「继续」时沿用上一条用户消息中的比例需求', async () => {
    const proposal = {
      action: 'generate',
      prompt: '主图，画面比例 1:1',
      requested_aspect_ratio: '1:1',
      parallel_count: 1,
      referenced_image_ids: [],
      reason: '先给 1:1 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_continue', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [
        { id: 'previous-request', role: 'user', text: '做一张 1:1 一张 3:4 的主图', createdAt: 9 },
        { id: 'continue', role: 'user', text: '继续', createdAt: 10 },
      ],
    });

    await streamAgentChat(input, callbacks).promise;

    expect(collected.done?.proposals?.map(item => item.requestedAspectRatio)).toEqual(['1:1', '3:4']);
  });

  it('「每张 3:4」按每张 1 张处理并补齐比例', async () => {
    const proposal = {
      action: 'generate',
      prompt: '主图，画面比例 1:1',
      requested_aspect_ratio: '1:1',
      parallel_count: 1,
      referenced_image_ids: [],
      reason: '先给 1:1 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_each', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'each-ratio', role: 'user', text: '每张 3:4 的主图', createdAt: 11 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const threeToFour = collected.done?.proposals?.find(item => item.requestedAspectRatio === '3:4');
    expect(threeToFour).toBeTruthy();
    expect(threeToFour!.parallelCount).toBe(1);
  });

  it('同一否定从句里的两个比例都不补齐：「不要出 2 张 1:1 和 5 张 3:4」', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 16:9',
      requested_aspect_ratio: '16:9',
      parallel_count: 1,
      referenced_image_ids: ['img_a'],
      reason: '先给横版方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_neg_both', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'neg-both', role: 'user', text: '不要出 2 张 1:1 和 5 张 3:4', createdAt: 12 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['16:9']);
    expect(ratios).not.toContain('1:1');
    expect(ratios).not.toContain('3:4');
  });

  it('「不要给我生成 2 张 1:1」不把 1:1 当需求补齐', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 1,
      referenced_image_ids: ['img_a'],
      reason: '3:4 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_neg_give', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'neg-give', role: 'user', text: '不要给我生成 2 张 1:1', createdAt: 13 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['3:4']);
    expect(ratios).not.toContain('1:1');
  });

  it('能力问句「能不能生成 2 张 1:1」不能误判为否定', async () => {
    const proposal = {
      action: 'generate',
      prompt: '主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 1,
      referenced_image_ids: [],
      reason: '先给 3:4 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_can_gen', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'can-gen', role: 'user', text: '能不能生成 2 张 1:1 的主图', createdAt: 14 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const oneToOne = collected.done?.proposals?.find(item => item.requestedAspectRatio === '1:1');
    expect(oneToOne).toBeTruthy();
    expect(oneToOne!.parallelCount).toBe(2);
  });

  it('用户明确「生成 5 张 3:4」时，模型已有 3:4 且 count=3 也要改成 5', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 3,
      referenced_image_ids: ['img_a'],
      reason: '3 张 3:4',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_count3', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'count-override', role: 'user', text: '生成 5 张 3:4', createdAt: 15 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const proposals = collected.done?.proposals || [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0].requestedAspectRatio).toBe('3:4');
    expect(proposals[0].parallelCount).toBe(5);
  });

  it('用户明确「生成 5 张 3:4」时，模型未给 count 也要补成 5', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      referenced_image_ids: ['img_a'],
      reason: '3:4 方案',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_nocount', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'count-fill', role: 'user', text: '生成 5 张 3:4', createdAt: 16 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const proposals = collected.done?.proposals || [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0].requestedAspectRatio).toBe('3:4');
    expect(proposals[0].parallelCount).toBe(5);
  });

  it('请求 12 张时 clamp 到 8', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 12,
      referenced_image_ids: ['img_a'],
      reason: '12 张',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_clamp', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'clamp12', role: 'user', text: '生成 12 张 3:4', createdAt: 17 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const proposals = collected.done?.proposals || [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0].requestedAspectRatio).toBe('3:4');
    expect(proposals[0].parallelCount).toBe(8);
  });

  it('已有 1:1 与 3:4 提案时同时纠正为用户要的 2 张和 5 张', async () => {
    const first = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 1:1',
      requested_aspect_ratio: '1:1',
      parallel_count: 1,
      referenced_image_ids: ['img_a'],
      reason: '1:1',
    };
    const second = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 3:4',
      requested_aspect_ratio: '3:4',
      parallel_count: 3,
      referenced_image_ids: ['img_a'],
      reason: '3:4',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_exist_11', function: { name: 'propose_image_action', arguments: JSON.stringify(first) } },
        { index: 1, id: 'call_exist_34', function: { name: 'propose_image_action', arguments: JSON.stringify(second) } },
      ] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'correct-both', role: 'user', text: '生成 2 张 1:1 和 5 张 3:4', createdAt: 18 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const proposals = collected.done?.proposals || [];
    expect(proposals).toHaveLength(2);
    expect(proposals.find(item => item.requestedAspectRatio === '1:1')?.parallelCount).toBe(2);
    expect(proposals.find(item => item.requestedAspectRatio === '3:4')?.parallelCount).toBe(5);
  });

  it('模型返回全角冒号比例时不重复补提案', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图，画面比例 1：1',
      requested_aspect_ratio: '1：1',
      parallel_count: 2,
      referenced_image_ids: ['img_a'],
      reason: '1：1',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fw', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'fullwidth', role: 'user', text: '生成 2 张 1:1', createdAt: 19 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['1:1']);
    expect(collected.done?.proposals?.[0].parallelCount).toBe(2);
  });

  it('模型返回方向词竖版时规范成 9:16 且不重复补提案', async () => {
    const proposal = {
      action: 'generate',
      prompt: '淘宝主图竖版',
      requested_aspect_ratio: '竖版',
      parallel_count: 1,
      referenced_image_ids: ['img_a'],
      reason: '竖版',
    };
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_dir', function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) } }] } }] }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    const input = baseInput('openai-chat-completions', {
      history: [{ id: 'dir-word', role: 'user', text: '做一张竖版的淘宝主图', createdAt: 20 }],
    });

    await streamAgentChat(input, callbacks).promise;

    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['9:16']);
  });

  it.each([
    '分别生成 2 张 1:1 的主图',
    '特别要 2 张 1:1 的主图',
  ])('含「别」的普通词不触发否定：%s', async (text) => {
    const collected = await runUserProposalCase(text, [baseGenerateProposal()]);
    const oneToOne = collected.done?.proposals?.find(item => item.requestedAspectRatio === '1:1');
    expect(oneToOne).toBeTruthy();
    expect(oneToOne!.parallelCount).toBe(2);
  });

  it.each([
    '可不可以生成 2 张 1:1 的主图',
    '可以不可以出 2 张 1:1 的主图',
    '用不用 2 张 1:1 的主图',
    '要不要 2 张 1:1 的主图',
  ])('能力/需求问句视为正向需求：%s', async (text) => {
    const collected = await runUserProposalCase(text, [baseGenerateProposal()]);
    const oneToOne = collected.done?.proposals?.find(item => item.requestedAspectRatio === '1:1');
    expect(oneToOne).toBeTruthy();
    expect(oneToOne!.parallelCount).toBe(2);
  });

  it('否定夹在数量与比例之间时不把 1:1 当正需求', async () => {
    const collected = await runUserProposalCase(
      '生成 2 张不要 1:1 的主图',
      [baseGenerateProposal()],
    );
    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['3:4']);
    expect(ratios).not.toContain('1:1');
  });

  it('同一否定从句里数量之后的多个比例都不补齐', async () => {
    const collected = await runUserProposalCase(
      '生成 2 张不要 1:1 和 3:4 的主图',
      [baseGenerateProposal({
        prompt: '淘宝主图，画面比例 16:9',
        requested_aspect_ratio: '16:9',
        reason: '先给横版方案',
      })],
    );
    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toEqual(['16:9']);
    expect(ratios).not.toContain('1:1');
    expect(ratios).not.toContain('3:4');
  });

  it.each([
    '不要 1:1，但要 3:4',
    '不要 1:1, 要 3:4',
    '不要 1:1、要 3:4',
    '不要 1:1但要 3:4',
  ])('明确转折后只保留正需求比例：%s', async (text) => {
    const collected = await runUserProposalCase(
      text,
      [baseGenerateProposal({
        prompt: '淘宝主图，画面比例 16:9',
        requested_aspect_ratio: '16:9',
        reason: '先给横版方案',
      })],
    );
    const ratios = collected.done?.proposals?.map(item => item.requestedAspectRatio) || [];
    expect(ratios).toContain('16:9');
    expect(ratios).toContain('3:4');
    expect(ratios).not.toContain('1:1');
    expect(collected.done?.proposals?.find(item => item.requestedAspectRatio === '3:4')?.parallelCount).toBe(1);
  });

  it('「生成 5 张，每张 3:4」抽为 3:4×5，不被每张=1 覆盖', async () => {
    const collected = await runUserProposalCase(
      '生成 5 张，每张 3:4',
      [baseGenerateProposal({
        prompt: '主图，画面比例 1:1',
        requested_aspect_ratio: '1:1',
        reason: '先给 1:1 方案',
      })],
    );
    const threeToFour = collected.done?.proposals?.find(item => item.requestedAspectRatio === '3:4');
    expect(threeToFour).toBeTruthy();
    expect(threeToFour!.parallelCount).toBe(5);
  });

  it('多链接禁止跨商品克隆缺失比例，但纠正每个已有同比例提案的张数', async () => {
    const collected = await runUserProposalCase(
      'https://item.taobao.com/item.htm?id=1 和 https://item.taobao.com/item.htm?id=2 每个链接 5 张 3:4 和 1 张 9:16',
      [
        baseGenerateProposal({
          prompt: '商品 A 主图',
          requested_aspect_ratio: '3:4',
          product_key: 'https://item.taobao.com/item.htm?id=1',
          product_name: '商品 A',
          referenced_image_ids: ['img_a'],
        }),
        baseGenerateProposal({
          prompt: '商品 B 主图',
          requested_aspect_ratio: '3:4',
          product_key: 'https://item.taobao.com/item.htm?id=2',
          product_name: '商品 B',
          referenced_image_ids: ['img_b'],
        }),
      ],
    );
    const proposals = collected.done?.proposals || [];
    expect(proposals.map(item => item.requestedAspectRatio)).toEqual(['3:4', '3:4']);
    expect(proposals.map(item => item.parallelCount)).toEqual([5, 5]);
    expect(proposals.map(item => item.productKey)).toEqual([
      'https://item.taobao.com/item.htm?id=1',
      'https://item.taobao.com/item.htm?id=2',
    ]);
  });

  it('同一淘宝商品不同追踪参数不算多来源，仍补齐缺失比例', async () => {
    const collected = await runUserProposalCase(
      'https://item.taobao.com/item.htm?id=893737826198&spm=a 和 https://item.taobao.com/item.htm?id=893737826198&mi_id=abc 做 1 张 1:1 和 1 张 3:4',
      [baseGenerateProposal({
        prompt: '主图，画面比例 1:1',
        requested_aspect_ratio: '1:1',
        product_key: 'https://item.taobao.com/item.htm?id=893737826198&spm=a',
      })],
    );
    expect(collected.done?.proposals?.map(item => item.requestedAspectRatio)).toEqual(['1:1', '3:4']);
  });

  it('用户输入全角比例「1：1」按 1:1 解析并补齐', async () => {
    const collected = await runUserProposalCase(
      '生成 2 张 1：1 的主图',
      [baseGenerateProposal()],
    );
    const oneToOne = collected.done?.proposals?.find(item => item.requestedAspectRatio === '1:1');
    expect(oneToOne).toBeTruthy();
    expect(oneToOne!.parallelCount).toBe(2);
  });

  it('模型连续调用工具超过最大轮数时强制收尾', async () => {
    const executor = vi.fn(async () => 'ok');
    const mock = vi.fn().mockImplementation(async () =>
      sseResponse(toolCallFrames('openai-chat-completions', 'browser_list_tabs', {}, 'call_x')),
    );
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();

    await streamAgentChat(baseInput('openai-chat-completions', { cdp: true, cdpExecutor: executor }), callbacks).promise;

    expect(mock).toHaveBeenCalledTimes(12);
    expect(executor).toHaveBeenCalledTimes(11);
    expect(collected.done?.proposal).toBeNull();
    expect(collected.done?.text).toContain('ok');
    expect(collected.toolActivity[0]).toContain('正在连接模型');
  });

  it('提案与浏览器工具同轮出现时，提案不丢失，与后续轮提案一起排队', async () => {
    const proposalA = {
      action: 'generate',
      prompt: '商品 A 的宣传图',
      referenced_image_ids: ['img_a1'],
      reason: '先做商品 A',
      product_key: 'https://item.taobao.com/item.htm?id=1',
    };
    const proposalB = {
      action: 'generate',
      prompt: '商品 B 的宣传图',
      referenced_image_ids: ['img_b1'],
      reason: '再做商品 B',
      product_key: 'https://item.taobao.com/item.htm?id=2',
    };
    // 第 1 轮：模型边给商品 A 提案、边调用浏览器打开商品 B（真实多商品场景的常见模式）
    const round1 = sseResponse([
      dataFrame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_pa', function: { name: 'propose_image_action', arguments: JSON.stringify(proposalA) } },
        { index: 1, id: 'call_open', function: { name: 'browser_open_url', arguments: JSON.stringify({ url: 'https://item.taobao.com/item.htm?id=2' }) } },
      ] } }] }),
      dataFrame('[DONE]'),
    ]);
    const round2 = sseResponse(toolCallFrames('openai-chat-completions', 'propose_image_action', proposalB, 'call_pb'));
    const executor = vi.fn(async () => '已打开商品 B 页面');
    const mock = vi.fn()
      .mockResolvedValueOnce(round1)
      .mockResolvedValueOnce(round2);
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();

    await streamAgentChat(baseInput('openai-chat-completions', { cdp: true, cdpExecutor: executor }), callbacks).promise;

    expect(executor).toHaveBeenCalledTimes(1);
    expect(collected.error).toBeNull();
    expect(collected.done?.proposal?.prompt).toBe('商品 A 的宣传图');
    expect(collected.done?.proposals?.map(item => item.prompt)).toEqual(['商品 A 的宣传图', '商品 B 的宣传图']);
  });

  it('流式输出期间只要持续有数据，就不因总时长超过 45 秒而失败', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }));
      const { callbacks, collected } = makeCallbacks();
      const pending = streamAgentChat(baseInput('openai-chat-completions'), callbacks).promise;

      for (let i = 0; i < 40; i += 1) await Promise.resolve();
      streamController.enqueue(encoder.encode(dataFrame({ choices: [{ delta: { content: '先' } }] })));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(40_000);
      streamController.enqueue(encoder.encode(dataFrame({ choices: [{ delta: { content: '后' } }] })));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(40_000);
      streamController.enqueue(encoder.encode(dataFrame('[DONE]')));
      streamController.close();
      await pending;

      expect(collected.error).toBeNull();
      expect(collected.done?.text).toContain('先后');
    } finally {
      vi.useRealTimers();
    }
  });

  it('单轮模型超时只重试该轮，不重新执行已完成的浏览器工具', async () => {
    vi.useFakeTimers();
    try {
      const executor = vi.fn(async () => '已抓取商品');
      let fetchCount = 0;
      const mock = vi.fn().mockImplementation(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return sseResponse(toolCallFrames(
            'openai-chat-completions',
            'browser_open_url',
            { url: 'https://item.taobao.com/item.htm?id=1' },
            'call_1',
          ));
        }
        return new Promise(() => {});
      });
      vi.stubGlobal('fetch', mock);
      const { callbacks, collected } = makeCallbacks();
      const pending = streamAgentChat(
        baseInput('openai-chat-completions', { cdp: true, cdpExecutor: executor }),
        callbacks,
      ).promise;

      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(executor).toHaveBeenCalledTimes(1);

      const settled = expect(pending).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(45_000 * 3 + 1_000);
      await settled;

      expect(executor).toHaveBeenCalledTimes(1);
      expect(collected.error?.message).toMatch(/超过/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('describeImage timeout', () => {
  it('上游不返回时按超时结束，不无限挂起', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const pending = describeImage('k', 'm', 'openai-chat-completions', 'data:image/png;base64,xx');
    const expectation = expect(pending).rejects.toThrow(/超过/);
    await vi.advanceTimersByTimeAsync(61_000);
    await expectation;
    vi.useRealTimers();
  });
});

describe('多图分别处理兜底拆分', () => {
  const SEPARATE_CATALOG = [
    { imgId: 'img_1', description: '化妆刷套装白底主图' },
    { imgId: 'img_2', description: '化妆刷套装场景图' },
    { imgId: 'img_3', description: '无关素材图' },
  ];

  type SplitProposal = { referencedImageIds: string[]; parallelCount?: number; prompt: string; reason: string };

  async function runSeparateCase(userText: string, modelProposals: Array<Record<string, unknown>>) {
    const mock = vi.fn().mockResolvedValue(sseResponse([
      dataFrame({
        choices: [{
          delta: {
            tool_calls: modelProposals.map((proposal, index) => ({
              index,
              id: `call_${index}`,
              function: { name: 'propose_image_action', arguments: JSON.stringify(proposal) },
            })),
          },
        }],
      }),
      dataFrame('[DONE]'),
    ]));
    vi.stubGlobal('fetch', mock);
    const { callbacks, collected } = makeCallbacks();
    await streamAgentChat(baseInput('openai-chat-completions', {
      history: [{ id: 'sep-case', role: 'user', text: userText, createdAt: 1 }],
      catalog: SEPARATE_CATALOG,
    }), callbacks).promise;
    return (collected.done?.proposals ?? []) as unknown as SplitProposal[];
  }

  function editProposal(refs: string[], overrides: Record<string, unknown> = {}) {
    return {
      action: 'edit',
      prompt: '仅将图1调整为1:1正方形构图，保留原图全部内容',
      referenced_image_ids: refs,
      reason: '调整比例',
      requested_aspect_ratio: '1:1',
      suggested_aspect_ratio: '1:1',
      parallel_count: 1,
      ...overrides,
    };
  }

  it('「把图1和图2都改成1:1」模型只出图2提案时，按点名顺序补足图1提案', async () => {
    const proposals = await runSeparateCase('把图1和图2都改成1:1', [
      editProposal(['img_2'], { prompt: '仅调整图2的画布尺寸适配1:1' }),
    ]);
    expect(proposals).toHaveLength(2);
    expect(proposals[0].referencedImageIds).toEqual(['img_1']);
    expect(proposals[1].referencedImageIds).toEqual(['img_2']);
    expect(proposals[0].parallelCount).toBe(1);
    expect(proposals[1].parallelCount).toBe(1);
    expect(proposals[0].prompt).toContain('图1');
    expect(proposals[0].prompt).not.toContain('图2');
  });

  it('多张被点名图塞进同一提案时拆成每图一个独立提案', async () => {
    const proposals = await runSeparateCase('把图1和图2都改成1:1', [
      editProposal(['img_1', 'img_2'], { parallel_count: 2, prompt: '将图1和图2分别调整为1:1构图' }),
    ]);
    expect(proposals).toHaveLength(2);
    expect(proposals[0].referencedImageIds).toEqual(['img_1']);
    expect(proposals[1].referencedImageIds).toEqual(['img_2']);
    expect(proposals[0].parallelCount).toBe(1);
    expect(proposals[0].prompt).not.toContain('图2');
  });

  it('模型已正确拆分时不多加提案', async () => {
    const proposals = await runSeparateCase('把图1和图2都改成1:1', [
      editProposal(['img_1']),
      editProposal(['img_2']),
    ]);
    expect(proposals).toHaveLength(2);
    expect(proposals.map(p => p.referencedImageIds[0])).toEqual(['img_1', 'img_2']);
  });

  it('合成/融合意图（无「都/分别」提示词）不拆：「参考图1和图2合成一张海报」保持原提案', async () => {
    const proposals = await runSeparateCase('参考图1和图2合成一张海报', [
      editProposal(['img_1', 'img_2'], { prompt: '参考图1的风格融合图2的主体做一张海报' }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].referencedImageIds).toEqual(['img_1', 'img_2']);
  });

  it('否定句不触发：「不要把图1和图2都改成1:1」不拆不补', async () => {
    const proposals = await runSeparateCase('不要把图1和图2都改成1:1，重新生成一张海报', [
      editProposal(['img_1']),
    ]);
    expect(proposals).toHaveLength(1);
  });

  it('模型完全没为被点名图出 edit 提案时不凭空发明', async () => {
    const proposals = await runSeparateCase('把图1和图2都改成1:1', [
      { ...editProposal([]), action: 'generate', referenced_image_ids: [] },
    ]);
    expect(proposals).toHaveLength(1);
  });
});
