import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChat } from '../useAgentChat';
import { AgentChatWorkspace } from '@/components/agent/AgentChatWorkspace';

const sessionGeneration = vi.hoisted(() => ({ value: 0 }));
const store = vi.hoisted(() => ({
  loadAgentSession: vi.fn(),
  loadPendingProposal: vi.fn(),
  loadPendingGeneration: vi.fn(),
  loadPendingGenerationTasks: vi.fn(),
  getAgentSessionGeneration: vi.fn(() => sessionGeneration.value),
  invalidateAgentSession: vi.fn(() => ++sessionGeneration.value),
  isAgentSessionGenerationCurrent: vi.fn((generation: number) => generation === sessionGeneration.value),
  putMessage: vi.fn(),
  putImageRecord: vi.fn(),
  saveImageModel: vi.fn(),
  clearAgentSession: vi.fn(),
  storeAgentImageBytes: vi.fn(),
  getAgentImageBase64: vi.fn(),
  deleteMessages: vi.fn(),
  deleteImageRecords: vi.fn(),
  deleteAgentImageIfUnreferenced: vi.fn(),
  deleteAgentImageBytes: vi.fn(),
  savePendingProposal: vi.fn(),
  clearPendingProposal: vi.fn(),
  savePendingGeneration: vi.fn(),
  savePendingGenerationTask: vi.fn(),
  removePendingGenerationTask: vi.fn(),
  clearPendingGeneration: vi.fn(),
  clearPendingGenerationTasks: vi.fn(),
  sweepAgentOrphanBlobsOnce: vi.fn(() => Promise.resolve(0)),
}));
const client = vi.hoisted(() => ({
  streamAgentChat: vi.fn(),
  describeImage: vi.fn(),
}));
const taskClient = vi.hoisted(() => ({
  createNovaTask: vi.fn(),
  getNovaTask: vi.fn(),
  resolveImageTaskProvider: vi.fn(),
}));
const imageDownloader = vi.hoisted(() => ({
  fetchImageAsBlob: vi.fn(),
}));

vi.mock('@/lib/agent-context-store', () => store);
vi.mock('@/lib/settings-storage', () => ({
  hasAnyApiKey: vi.fn(() => true),
  loadJsonFromStorage: vi.fn(() => ({})),
  saveJsonToStorage: vi.fn(),
}));
vi.mock('@/lib/uuid', () => ({ generateUUID: vi.fn(() => 'generated-message-id') }));
vi.mock('@/lib/model-capabilities', () => ({
  getGptImageAdvancedParamsForModel: vi.fn(() => ({ quality: 'auto', style: 'auto', background: 'auto' })),
  resolveAgentModel: vi.fn(),
  getAspectRatioOptions: vi.fn(() => [{ value: '1:1' }]),
  getCustomSizeMaxSide: vi.fn(() => 2048),
  getSupportsTemperature: vi.fn(() => false),
  getValidOutputSizes: vi.fn(() => ['1K']),
  normalizeCustomImageSize: vi.fn((value: string | undefined) => value),
  normalizeModel: vi.fn((value: string) => value),
  sanitizeLayoutForModel: vi.fn(),
  resolveSubmitLayout: vi.fn((_model: string, outputSize: string, aspectRatio: string) => ({ outputSize, aspectRatio })),
  supportsCustomSize: vi.fn(() => false),
  supportsGptImageAdvancedParams: vi.fn(() => false),
  PARALLEL_COUNT_VALUES: [1, 2, 3, 4],
  CUSTOM_IMAGE_SIZE_LIMITS: { multiple: 16, maxAspectRatio: 3, minPixels: 655360, maxPixels: 8294400 },
}));
vi.mock('@/lib/nova-models', () => ({
  getCompleteImageModels: vi.fn(() => []),
  getDefaultImageModel: vi.fn(() => undefined),
  getImageModelById: vi.fn(() => undefined),
  loadRegistry: vi.fn(() => ({})),
}));
vi.mock('@/lib/agent-chat-client', () => client);
vi.mock('@/lib/ccode-task-client', () => taskClient);
vi.mock('@/lib/image-downloader', () => imageDownloader);
vi.mock('@/lib/agent-cdp-tools', () => ({
  executeAgentCdpTool: vi.fn(),
  purgeCdpProductImages: vi.fn(),
}));
vi.mock('@/lib/model-endpoints', () => ({
  getDefaultConfiguredTextModel: vi.fn(() => ({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    modelId: 'test-text-model',
    protocol: 'openai-compatible',
  })),
}));
vi.mock('@/lib/nova-text-protocol', () => ({ supportsAgentNativeWebSearch: vi.fn(() => false) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    action: 'generate' as const,
    prompt: '生成测试图片',
    referencedImageIds: [],
    reason: '测试提案',
    ...overrides,
  };
}

function resolvedLayout() {
  return {
    outputSize: '1K' as const,
    aspectRatio: '1:1' as const,
    temperature: 1,
    gptImageQuality: 'auto' as const,
    gptImageStyle: 'natural' as const,
    gptImageBackground: 'auto' as const,
    parallelCount: 1 as const,
  };
}

function pendingGeneration(taskId: string, background = false) {
  return {
    taskId,
    proposal: proposal({ prompt: `${taskId} prompt`, productKey: taskId, productName: taskId }),
    pendingAnalysis: `${taskId} analysis`,
    pendingReasoning: '',
    selectedImageIds: [],
    model: 'image-model',
    outputSize: '1K',
    aspectRatio: '1:1',
    temperature: 1,
    parallelCount: 1,
    startedAt: 1,
    background,
  };
}

describe('useAgentChat session binding', () => {
  beforeEach(() => {
    sessionGeneration.value = 0;
    vi.clearAllMocks();
    store.loadAgentSession.mockResolvedValue({
      messages: [{ id: 'message-1', role: 'assistant', text: 'existing', createdAt: 1 }],
      images: [{
        imgId: 'image-1',
        source: 'uploaded',
        thumbnail: 'data:image/png;base64,AA==',
        description: 'old description',
        mimeType: 'image/png',
        createdAt: 1,
      }],
      imageModel: null,
    });
    store.loadPendingProposal.mockResolvedValue(null);
    store.loadPendingGeneration.mockResolvedValue(null);
    store.loadPendingGenerationTasks.mockResolvedValue([]);
    store.putMessage.mockResolvedValue(undefined);
    store.putImageRecord.mockResolvedValue(undefined);
    store.saveImageModel.mockResolvedValue(undefined);
    store.savePendingGeneration.mockResolvedValue(undefined);
    store.savePendingGenerationTask.mockResolvedValue(undefined);
    store.removePendingGenerationTask.mockResolvedValue(undefined);
    store.clearPendingGeneration.mockResolvedValue(undefined);
    store.clearPendingGenerationTasks.mockResolvedValue(undefined);
    client.describeImage.mockResolvedValue('updated description');
    client.streamAgentChat.mockReturnValue({ abort: vi.fn() });
    taskClient.createNovaTask.mockResolvedValue('task-default');
    taskClient.getNovaTask.mockResolvedValue({ status: 'processing' });
    taskClient.resolveImageTaskProvider.mockReturnValue({
      apiKey: 'image-key',
      baseUrl: 'https://example.test',
      protocol: 'openai-compatible',
      modelId: 'image-model',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the explicit sessionId to session loading and message/image persistence', async () => {
    const { result } = renderHook(() => useAgentChat('session-42'));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(store.loadAgentSession).toHaveBeenCalledWith('session-42');

    await act(async () => {
      result.current.clearContext();
    });
    expect(store.putMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'context-divider' }),
      'session-42',
    );

    await act(async () => {
      await result.current.redescribeImage('image-1');
    });
    expect(store.putImageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ imgId: 'image-1', description: 'updated description' }),
      'session-42',
      0,
    );
  });

  it('does not persist a description that finishes after unmount', async () => {
    const description = deferred<string>();
    client.describeImage.mockReturnValueOnce(description.promise);
    const hook = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    const redescribe = hook.result.current.redescribeImage('image-1');
    hook.unmount();
    await act(async () => description.resolve('late description'));
    await redescribe;

    expect(store.putImageRecord).not.toHaveBeenCalled();
  });

  it('does not persist a description that finishes after clear', async () => {
    const description = deferred<string>();
    client.describeImage.mockReturnValueOnce(description.promise);
    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    const redescribe = result.current.redescribeImage('image-1');
    await act(async () => result.current.clearSession());
    await act(async () => description.resolve('late description'));
    await redescribe;

    expect(result.current.images).toEqual([]);
    expect(store.putImageRecord).not.toHaveBeenCalled();
  });

  it('does not persist an upload whose download finishes after clear', async () => {
    const download = deferred<Blob>();
    imageDownloader.fetchImageAsBlob.mockReturnValueOnce(download.promise);
    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    let send!: Promise<void>;
    act(() => {
      send = result.current.sendMessage('旧请求', [{
        id: 'upload-hash',
        name: 'late.png',
        preview: '',
        dataUrl: 'URL:https://example.test/late.png',
        mimeType: 'image/png',
      }]);
    });
    await waitFor(() => expect(imageDownloader.fetchImageAsBlob).toHaveBeenCalled());
    await act(async () => result.current.clearSession());
    await act(async () => download.resolve(new Blob(['late'], { type: 'image/png' })));
    await send;

    expect(result.current.images).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(store.putImageRecord).not.toHaveBeenCalled();
    expect(client.streamAgentChat).not.toHaveBeenCalled();
  });

  it('passes the sessionId when clearing the session', async () => {
    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.clearSession();
    });

    expect(store.clearAgentSession).toHaveBeenCalledWith('session-42', 1);
  });

  it('passes the sessionId when retrying and deleting the previous turn', async () => {
    store.loadAgentSession.mockResolvedValueOnce({
      messages: [
        { id: 'user-1', role: 'user', text: '请求', createdAt: 1 },
        { id: 'assistant-1', role: 'assistant', text: '回复', createdAt: 2 },
      ],
      images: [],
      imageModel: null,
    });
    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.retryMessage('user-1');
    });

    expect(store.deleteMessages).toHaveBeenCalledWith(['assistant-1'], 'session-42');
  });

  it('withdraws outside the state updater and removes orphaned images once', async () => {
    store.loadAgentSession.mockResolvedValueOnce({
      messages: [
        { id: 'user-1', role: 'user', text: '请求', imageIds: ['image-1'], createdAt: 1 },
        { id: 'note-1', role: 'system-note', text: '已取消', withdrawable: true, createdAt: 2 },
      ],
      images: [{
        imgId: 'image-1',
        source: 'uploaded',
        thumbnail: 'data:image/png;base64,AA==',
        description: 'old description',
        mimeType: 'image/png',
        createdAt: 1,
      }],
      imageModel: null,
    });
    const { result } = renderHook(() => useAgentChat('session-42'), { wrapper: StrictModeWrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.withdrawTurn('note-1'));

    expect(result.current.messages).toEqual([]);
    expect(store.deleteMessages).toHaveBeenCalledTimes(1);
    expect(store.deleteMessages).toHaveBeenCalledWith(['user-1', 'note-1'], 'session-42');
    expect(store.deleteImageRecords).toHaveBeenCalledWith(['image-1'], 'session-42');
    expect(store.deleteAgentImageBytes).toHaveBeenCalledWith('image-1', 'session-42');
  });

  it('rejects delete, rollback, and withdraw while a generation is active', async () => {
    store.loadPendingGenerationTasks.mockResolvedValue([pendingGeneration('active-task')]);
    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.phase).toBe('generating'));
    const originalMessages = result.current.messages;

    act(() => {
      result.current.deleteMessage('message-1');
      result.current.rollbackMessages('message-1');
      result.current.withdrawTurn('message-1');
    });

    expect(result.current.messages).toEqual(originalMessages);
    expect(store.deleteMessages).not.toHaveBeenCalled();
  });

  it('restores the mounted state after StrictMode effect replay', async () => {
    client.streamAgentChat.mockReturnValue({ abort: vi.fn() });
    const { result } = renderHook(() => useAgentChat('session-42'), { wrapper: StrictModeWrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage('strict-mode ping', [], []);
    });

    expect(store.putMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', text: 'strict-mode ping' }),
      'session-42',
      0,
    );
  });

  it('does not send while session restoration is still pending', async () => {
    const session = deferred<{
      messages: [{ id: string; role: 'assistant'; text: string; createdAt: number }];
      images: never[];
      imageModel: null;
    }>();
    store.loadAgentSession.mockReturnValueOnce(session.promise);

    const { result } = renderHook(() => useAgentChat('session-42'));
    expect(result.current.ready).toBe(false);

    await act(async () => {
      await result.current.sendMessage('抢跑消息', [], []);
    });

    expect(client.streamAgentChat).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      session.resolve({
        messages: [{ id: 'restored-message', role: 'assistant' as const, text: '已恢复', createdAt: 1 }],
        images: [],
        imageModel: null,
      });
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it('disables Workspace send and upload controls before session restoration completes', async () => {
    const session = deferred<{
      messages: [];
      images: never[];
      imageModel: null;
    }>();
    store.loadAgentSession.mockReturnValueOnce(session.promise);

    const workspace = render(<AgentChatWorkspace activeSessionId="session-42" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByTitle('发送')).toBeDisabled();
    expect(screen.getByTitle('上传图片')).toBeDisabled();

    await act(async () => {
      session.resolve({ messages: [], images: [], imageModel: null });
    });
    workspace.unmount();
  });

  it('persists every background-approved generation for refresh recovery', async () => {
    let onDone!: (fullText: string, parsedProposal: ReturnType<typeof proposal>, parsedProposals?: ReturnType<typeof proposal>[]) => void;
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onDone = callbacks.onDone;
      return { abort: vi.fn() };
    });
    taskClient.createNovaTask
      .mockResolvedValueOnce('background-task-1')
      .mockResolvedValueOnce('background-task-2');

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.sendMessage('批量请求', [], []);
    });

    const first = proposal({ productKey: 'product-a', productName: '商品 A' });
    const second = proposal({ productKey: 'product-b', productName: '商品 B' });
    const third = proposal({ productKey: 'product-c', productName: '商品 C' });
    act(() => onDone('', first, [first, second, third]));

    await act(async () => {
      await result.current.approveProposal('确认商品 A', [], 'image-model', resolvedLayout());
    });
    await act(async () => {
      await result.current.approveProposal('确认商品 B', [], 'image-model', resolvedLayout());
    });

    expect(store.savePendingGenerationTask).toHaveBeenCalledTimes(2);
    expect(store.savePendingGenerationTask).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ taskId: 'background-task-1', background: true }),
      'session-42',
    );
    expect(store.savePendingGenerationTask).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ taskId: 'background-task-2', background: true }),
      'session-42',
    );
    expect(store.putMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system-note',
        text: expect.stringContaining('后台生成中'),
      }),
      'session-42',
      0,
    );
    expect(store.putMessage.mock.calls.some(([message]) => String(message.text || '').includes('剩余 0 个'))).toBe(false);
    act(() => result.current.stopStreaming());
  });

  it('resumes polling every persisted background task after remount', async () => {
    store.loadPendingGenerationTasks.mockResolvedValue([
      pendingGeneration('background-task-1', true),
      pendingGeneration('background-task-2', true),
    ]);
    taskClient.getNovaTask.mockResolvedValue({ status: 'processing' });

    const firstMount = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => {
      expect(taskClient.getNovaTask).toHaveBeenCalledWith('background-task-1');
      expect(taskClient.getNovaTask).toHaveBeenCalledWith('background-task-2');
    });
    firstMount.unmount();

    const secondMount = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => {
      expect(taskClient.getNovaTask.mock.calls.filter(([id]) => id === 'background-task-1')).toHaveLength(2);
      expect(taskClient.getNovaTask.mock.calls.filter(([id]) => id === 'background-task-2')).toHaveLength(2);
    });
    secondMount.unmount();
  });

  it('removes generated images when unmounted between record and message persistence', async () => {
    const secondRecordWrite = deferred<void>();
    store.loadPendingGenerationTasks.mockResolvedValue([pendingGeneration('completed-task')]);
    client.describeImage.mockReturnValue(new Promise(() => {}));
    store.putImageRecord
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(secondRecordWrite.promise);
    taskClient.getNovaTask.mockResolvedValue({
      status: 'completed',
      result: { images: ['data:image/png;base64,eA==', 'data:image/png;base64,eQ=='] },
    });

    const hook = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(store.putImageRecord).toHaveBeenCalledTimes(2));
    hook.unmount();
    await act(async () => secondRecordWrite.resolve());

    await waitFor(() => expect(store.deleteAgentImageIfUnreferenced).toHaveBeenCalledTimes(2));
    expect(store.deleteAgentImageIfUnreferenced).toHaveBeenCalledWith(
      expect.objectContaining({ imgId: 'img_1', sourceTaskId: 'completed-task' }),
      'session-42',
      0,
    );
    expect(store.deleteAgentImageIfUnreferenced).toHaveBeenCalledWith(
      expect.objectContaining({ imgId: 'img_2', sourceTaskId: 'completed-task' }),
      'session-42',
      0,
    );
    expect(store.putMessage.mock.calls.some(([message]) => message.taskId === 'completed-task')).toBe(false);
  });

  it('restores a failed background task as a reeditable proposal', async () => {
    store.loadPendingGenerationTasks.mockResolvedValue([pendingGeneration('failed-task', true)]);
    taskClient.getNovaTask.mockResolvedValue({ status: 'failed', error: 'provider failed' });

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.messages.some(message => message.proposalData?.prompt === 'failed-task prompt')).toBe(true));

    const failedMessage = result.current.messages.find(message => message.proposalData?.prompt === 'failed-task prompt')!;
    act(() => result.current.reeditProposal(failedMessage.id));

    expect(result.current.phase).toBe('proposal');
    expect(result.current.proposal).toEqual(expect.objectContaining({ prompt: 'failed-task prompt' }));
    expect(taskClient.createNovaTask).not.toHaveBeenCalled();
    expect(client.streamAgentChat).not.toHaveBeenCalled();
    expect(store.removePendingGenerationTask).toHaveBeenCalledWith('failed-task', 'session-42');
    expect(store.putMessage.mock.invocationCallOrder[0]).toBeLessThan(
      store.removePendingGenerationTask.mock.invocationCallOrder[0],
    );
  });

  it('shows reedit for a failed background task without generated images', async () => {
    store.loadPendingGenerationTasks.mockResolvedValue([pendingGeneration('failed-task', true)]);
    taskClient.getNovaTask.mockResolvedValue({ status: 'failed', error: 'provider failed' });

    const workspace = render(<AgentChatWorkspace activeSessionId="session-42" />);

    expect(await screen.findByRole('button', { name: '重新编辑' })).toBeEnabled();
    workspace.unmount();
  });

  it('persists foreground failure proposalData instead of a late pending-proposal save', async () => {
    store.loadPendingGenerationTasks.mockResolvedValue([pendingGeneration('foreground-failure')]);
    taskClient.getNovaTask.mockResolvedValue({ status: 'failed', error: 'provider failed' });

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.phase).toBe('proposal'));

    expect(result.current.messages.some(message => message.proposalData?.prompt === 'foreground-failure prompt')).toBe(true);
    expect(store.savePendingProposal).not.toHaveBeenCalled();
    expect(store.putMessage.mock.invocationCallOrder[0]).toBeLessThan(
      store.removePendingGenerationTask.mock.invocationCallOrder[0],
    );
  });

  it('queues stop cleanup after an in-flight pending-task save', async () => {
    let onDone!: (fullText: string, parsedProposal: ReturnType<typeof proposal>, parsedProposals?: ReturnType<typeof proposal>[]) => void;
    const saveGate = deferred<void>();
    const persisted = new Set<string>();
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onDone = callbacks.onDone;
      return { abort: vi.fn() };
    });
    taskClient.createNovaTask.mockResolvedValueOnce('save-race-task');
    store.savePendingGenerationTask.mockImplementationOnce(async data => {
      await saveGate.promise;
      persisted.add(data.taskId);
    });
    store.removePendingGenerationTask.mockImplementationOnce(async taskId => {
      persisted.delete(taskId);
    });

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => result.current.sendMessage('保存竞态', [], []));
    const pending = proposal({ productKey: 'save-race' });
    act(() => onDone('', pending, [pending]));

    let approval!: Promise<void>;
    act(() => { approval = result.current.approveProposal(pending.prompt, [], 'image-model', resolvedLayout()); });
    await waitFor(() => expect(store.savePendingGenerationTask).toHaveBeenCalled());
    act(() => result.current.stopStreaming());
    await act(async () => saveGate.resolve());
    await waitFor(() => expect(store.removePendingGenerationTask).toHaveBeenCalledWith('save-race-task', 'session-42'));
    await act(async () => approval);

    expect([...persisted]).toEqual([]);
    expect(taskClient.getNovaTask).not.toHaveBeenCalled();
  });

  it('persists a submitted task to its old session when session switch unmounts before task creation returns', async () => {
    let onDone!: (fullText: string, parsedProposal: ReturnType<typeof proposal>, parsedProposals?: ReturnType<typeof proposal>[]) => void;
    const task = deferred<string>();
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onDone = callbacks.onDone;
      return { abort: vi.fn() };
    });
    taskClient.createNovaTask.mockReturnValueOnce(task.promise);

    const hook = renderHook(() => useAgentChat('old-session'));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(async () => hook.result.current.sendMessage('会话切换竞态', [], []));
    const first = proposal({ productKey: 'old-product' });
    const next = proposal({ productKey: 'next-product' });
    act(() => onDone('', first, [first, next]));

    let approval!: Promise<void>;
    act(() => { approval = hook.result.current.approveProposal(first.prompt, [], 'image-model', resolvedLayout()); });
    hook.unmount();
    task.resolve('old-session-task');
    await approval;

    expect(store.savePendingGenerationTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'old-session-task', background: true }),
      'old-session',
    );
    expect(taskClient.getNovaTask).not.toHaveBeenCalled();
  });

  it('does not resurrect a task whose creation finishes after stopStreaming', async () => {
    let onDone!: (fullText: string, parsedProposal: ReturnType<typeof proposal>, parsedProposals?: ReturnType<typeof proposal>[]) => void;
    const task = deferred<string>();
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onDone = callbacks.onDone;
      return { abort: vi.fn() };
    });
    taskClient.createNovaTask.mockReturnValueOnce(task.promise);

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.sendMessage('停止竞态', [], []);
    });
    const pending = proposal({ productKey: 'pending-task' });
    act(() => onDone('', pending, [pending]));

    let approval!: Promise<void>;
    act(() => { approval = result.current.approveProposal(pending.prompt, [], 'image-model', resolvedLayout()); });
    act(() => result.current.stopStreaming());
    await act(async () => {
      task.resolve('late-task');
      await approval;
    });

    expect(store.savePendingGenerationTask).not.toHaveBeenCalled();
    expect(taskClient.getNovaTask).not.toHaveBeenCalled();
  });

  it('keeps cancellation isolated when a later task starts', async () => {
    let onDone!: (fullText: string, parsedProposal: ReturnType<typeof proposal>, parsedProposals?: ReturnType<typeof proposal>[]) => void;
    const pollCalls: string[] = [];
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onDone = callbacks.onDone;
      return { abort: vi.fn() };
    });
    taskClient.createNovaTask
      .mockResolvedValueOnce('task-1')
      .mockResolvedValueOnce('task-2')
      .mockResolvedValueOnce('task-3');
    taskClient.getNovaTask.mockImplementation(async (taskId: string) => {
      pollCalls.push(taskId);
      return { status: 'processing' };
    });

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.useFakeTimers();

    await act(async () => {
      await result.current.sendMessage('三个商品', [], []);
    });
    const first = proposal({ productKey: 'product-a' });
    const second = proposal({ productKey: 'product-b' });
    const third = proposal({ productKey: 'product-c' });
    act(() => onDone('', first, [first, second, third]));

    await act(async () => {
      await result.current.approveProposal(first.prompt, [], 'image-model', resolvedLayout());
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pollCalls).toContain('task-1');

    await act(async () => {
      await result.current.approveProposal(second.prompt, [], 'image-model', resolvedLayout());
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pollCalls).toContain('task-2');

    const task1CallsBeforeStop = pollCalls.filter(taskId => taskId === 'task-1').length;
    const task2CallsBeforeStop = pollCalls.filter(taskId => taskId === 'task-2').length;
    act(() => result.current.stopStreaming());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.sendMessage('停止后新任务', [], []);
    });
    const replacement = proposal({ productKey: 'replacement' });
    act(() => onDone('', replacement, [replacement]));
    let replacementApproval!: Promise<void>;
    act(() => { replacementApproval = result.current.approveProposal(replacement.prompt, [], 'image-model', resolvedLayout()); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pollCalls.filter(taskId => taskId === 'task-1').length).toBe(task1CallsBeforeStop);
    expect(pollCalls.filter(taskId => taskId === 'task-2').length).toBe(task2CallsBeforeStop);

    act(() => result.current.stopStreaming());
    await act(async () => {
      await replacementApproval;
    });
  });

  it('persists a system note when the agent stream errors', async () => {
    let onError!: (error: Error) => void;
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onError = callbacks.onError;
      return { abort: vi.fn() };
    });

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.sendMessage('一只红色陶瓷杯', [], []);
    });

    act(() => onError(new Error('HTTP 429: All accounts exhausted')));

    expect(result.current.error).toBe('HTTP 429: All accounts exhausted');
    expect(result.current.phase).toBe('idle');
    expect(result.current.messages.some(message => (
      message.role === 'system-note' && message.text.includes('HTTP 429: All accounts exhausted')
    ))).toBe(true);
    expect(store.putMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system-note',
        text: '请求失败：HTTP 429: All accounts exhausted',
      }),
      'session-42',
      0,
    );
  });

  it('参考图下载失败时保留提案并显示错误，不退化为文字生图', async () => {
    let onDone!: (fullText: string, parsedProposal: ReturnType<typeof proposal>, parsedProposals?: ReturnType<typeof proposal>[]) => void;
    client.streamAgentChat.mockImplementation((_request, callbacks) => {
      onDone = callbacks.onDone;
      return { abort: vi.fn() };
    });
    store.getAgentImageBase64.mockResolvedValueOnce(null);
    taskClient.getNovaTask.mockResolvedValueOnce({ status: 'failed', error: 'unexpected text-to-image fallback' });

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => result.current.sendMessage('按参考图修改', [], []));
    const pending = proposal({ action: 'edit', referencedImageIds: ['remote-image'] });
    act(() => onDone('', pending, [pending]));
    await waitFor(() => expect(result.current.phase).toBe('proposal'));

    await act(async () => {
      await result.current.approveProposal('按参考图修改', ['remote-image'], 'image-model', resolvedLayout());
    });

    expect(taskClient.createNovaTask).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('proposal');
    expect(result.current.proposal).toEqual(expect.objectContaining({ referencedImageIds: ['remote-image'] }));
    expect(result.current.error).toMatch(/参考图下载失败/);
  });

  it('CDP 抓图登记消息携带 imageIds，重试/撤回时可被孤儿清理', async () => {
    localStorage.setItem('nova-agent-cdp', 'true');
    try {
      const { executeAgentCdpTool } = await import('@/lib/agent-cdp-tools');
      const mockedExec = vi.mocked(executeAgentCdpTool);
      mockedExec.mockResolvedValue({
        text: '商品标题：测试商品',
        localUrls: ['/api/nova/cdp/products/a.jpg'],
        sourceKey: 'https://item.taobao.com/item.htm?id=1',
        sourceTitle: '测试商品',
        sourceUrl: 'https://item.taobao.com/item.htm?id=1',
      } as Awaited<ReturnType<typeof executeAgentCdpTool>>);
      imageDownloader.fetchImageAsBlob.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }));
      client.streamAgentChat.mockImplementation((input, callbacks) => {
        const promise = (async () => {
          await input.cdpExecutor?.('browser_read_taobao', {});
          callbacks.onDone('完成', null);
        })();
        return { abort: vi.fn(), promise };
      });

      const { result } = renderHook(() => useAgentChat('session-42'));
      await waitFor(() => expect(result.current.ready).toBe(true));

      await act(async () => {
        await result.current.sendMessage('抓取这个链接 https://item.taobao.com/item.htm?id=1', [], []);
      });

      await waitFor(() => expect(mockedExec).toHaveBeenCalled());
      await waitFor(() => expect(store.putMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          text: expect.stringContaining('已从浏览器抓取'),
          imageIds: ['img_1'],
        }),
        'session-42',
        0,
      ));
    } finally {
      localStorage.removeItem('nova-agent-cdp');
    }
  });

  it('CDP 重复抓取同一 URL 时复用已登记图片，不重复下载/登记', async () => {
    localStorage.setItem('nova-agent-cdp', 'true');
    try {
      store.loadAgentSession.mockResolvedValueOnce({
        messages: [],
        images: [{
          imgId: 'img_1',
          source: 'uploaded',
          thumbnail: 'data:image/jpeg;base64,AA==',
          description: '商品《测试商品》的图',
          mimeType: 'image/jpeg',
          remoteUrl: '/api/nova/cdp/products/a.jpg',
          createdAt: 1,
        }],
        imageModel: null,
      });
      const { executeAgentCdpTool } = await import('@/lib/agent-cdp-tools');
      const mockedExec = vi.mocked(executeAgentCdpTool);
      mockedExec.mockResolvedValue({
        text: '商品标题：测试商品',
        localUrls: ['/api/nova/cdp/products/a.jpg'],
        sourceKey: 'https://item.taobao.com/item.htm?id=1',
        sourceTitle: '测试商品',
        sourceUrl: 'https://item.taobao.com/item.htm?id=1',
      } as Awaited<ReturnType<typeof executeAgentCdpTool>>);
      client.streamAgentChat.mockImplementation((input, callbacks) => {
        const promise = (async () => {
          await input.cdpExecutor?.('browser_read_taobao', {});
          callbacks.onDone('完成', null);
        })();
        return { abort: vi.fn(), promise };
      });

      const { result } = renderHook(() => useAgentChat('session-42'));
      await waitFor(() => expect(result.current.ready).toBe(true));

      await act(async () => {
        await result.current.sendMessage('再抓一次 https://item.taobao.com/item.htm?id=1', [], []);
      });

      // 复用已登记的 img_1：不再下载缩略图、不再写登记记录，消息仍引用同一图片
      await waitFor(() => expect(store.putMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          text: expect.stringContaining('已从浏览器抓取'),
          imageIds: ['img_1'],
        }),
        'session-42',
        0,
      ));
      expect(imageDownloader.fetchImageAsBlob).not.toHaveBeenCalled();
      expect(store.putImageRecord).not.toHaveBeenCalled();
    } finally {
      localStorage.removeItem('nova-agent-cdp');
    }
  });

  it('does not register CDP images whose download finishes after clear', async () => {
    localStorage.setItem('nova-agent-cdp', 'true');
    try {
      const { executeAgentCdpTool } = await import('@/lib/agent-cdp-tools');
      const mockedExec = vi.mocked(executeAgentCdpTool);
      const secondDownload = deferred<Blob>();
      mockedExec.mockResolvedValue({
        text: '商品标题：测试商品',
        localUrls: ['/api/nova/cdp/products/first.jpg', '/api/nova/cdp/products/late.jpg'],
        sourceTitle: '测试商品',
      } as Awaited<ReturnType<typeof executeAgentCdpTool>>);
      imageDownloader.fetchImageAsBlob
        .mockResolvedValueOnce(new Blob(['first'], { type: 'image/jpeg' }))
        .mockReturnValueOnce(secondDownload.promise);
      client.streamAgentChat.mockImplementation((input, callbacks) => {
        const promise = (async () => {
          await input.cdpExecutor?.('browser_read_taobao', {});
          callbacks.onDone('完成', null);
        })();
        return { abort: vi.fn(), promise };
      });

      const { result } = renderHook(() => useAgentChat('session-42'));
      await waitFor(() => expect(result.current.ready).toBe(true));
      await act(async () => result.current.sendMessage('抓图', [], []));
      await waitFor(() => expect(imageDownloader.fetchImageAsBlob).toHaveBeenCalledTimes(2));

      await act(async () => result.current.clearSession());
      await act(async () => secondDownload.resolve(new Blob(['late'], { type: 'image/jpeg' })));

      await waitFor(() => expect(result.current.phase).toBe('idle'));
      expect(result.current.images).toEqual([]);
      expect(store.putImageRecord).toHaveBeenCalledTimes(1);
      expect(store.deleteAgentImageIfUnreferenced).toHaveBeenCalledWith(
        expect.objectContaining({ imgId: 'img_1', remoteUrl: '/api/nova/cdp/products/first.jpg' }),
        'session-42',
        0,
      );
      expect(store.putMessage.mock.calls.some(([message]) => message.imageIds?.includes('img_1'))).toBe(false);
    } finally {
      localStorage.removeItem('nova-agent-cdp');
    }
  });

  it('清空会话时删除本会话登记过的 CDP 落盘图', async () => {
    store.loadAgentSession.mockResolvedValueOnce({
      messages: [],
      images: [{
        imgId: 'img_1',
        source: 'uploaded',
        thumbnail: 'data:image/jpeg;base64,AA==',
        description: '商品图',
        mimeType: 'image/jpeg',
        remoteUrl: '/api/nova/cdp/products/p_aaaaaaaaaaaaaaaa_1.jpg',
        createdAt: 1,
      }],
      imageModel: null,
    });
    const { purgeCdpProductImages } = await import('@/lib/agent-cdp-tools');
    const mockedPurge = vi.mocked(purgeCdpProductImages);
    mockedPurge.mockResolvedValue(1);

    const { result } = renderHook(() => useAgentChat('session-42'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.clearSession();
    });

    expect(mockedPurge).toHaveBeenCalledWith(['/api/nova/cdp/products/p_aaaaaaaaaaaaaaaa_1.jpg']);
    expect(store.clearAgentSession).toHaveBeenCalledWith('session-42', 1);
  });
});
