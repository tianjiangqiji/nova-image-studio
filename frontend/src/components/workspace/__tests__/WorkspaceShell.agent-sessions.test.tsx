import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../WorkspaceShell';

const sessionApi = vi.hoisted(() => ({
  getActiveAgentSessionId: vi.fn(),
  setActiveAgentSessionId: vi.fn(),
}));
const contextStore = vi.hoisted(() => ({
  setAgentSession: vi.fn(),
}));
const mounts = vi.hoisted(() => ({
  count: 0,
  lastSessionId: undefined as string | undefined,
}));

vi.mock('@/lib/agent-sessions', () => sessionApi);
vi.mock('@/lib/agent-context-store', () => contextStore);

vi.mock('@/components/agent/SessionSwitcher', () => ({
  SessionSwitcher: ({ activeSessionId, onSessionChange }: {
    activeSessionId: string;
    onSessionChange: (sessionId: string) => Promise<void>;
  }) => (
    <button type="button" onClick={() => void onSessionChange('design')}>
      session:{activeSessionId}
    </button>
  ),
}));

vi.mock('@/components/agent/AgentChatWorkspace', async () => {
  const React = await import('react');
  return {
    AgentChatWorkspace: ({ activeSessionId }: { activeSessionId?: string }) => {
      React.useEffect(() => {
        mounts.count += 1;
        mounts.lastSessionId = activeSessionId;
      }, [activeSessionId]);
      return <div>agent-workspace:{activeSessionId}</div>;
    },
  };
});

vi.mock('@/components/ImageGenerationWorkbench', () => ({ ImageGenerationWorkbench: () => null }));
vi.mock('@/components/ReversePromptForm', () => ({ ReversePromptForm: () => null }));
vi.mock('@/components/GifGenerationWorkspace', () => ({ GifGenerationWorkspace: () => null }));
vi.mock('@/components/assets/AssetsWorkspace', () => ({ AssetsWorkspace: () => null }));
vi.mock('@/components/canvas/CanvasWorkspace', () => ({ CanvasWorkspace: () => null }));
vi.mock('@/components/slice/SliceWorkspace', () => ({ SliceWorkspace: () => null }));
vi.mock('@/components/PromptGallery', () => ({ PromptGallery: () => null }));
vi.mock('@/components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('@/components/MissingApiKeyDialog', () => ({ MissingApiKeyDialog: () => null }));
vi.mock('@/components/workspace/WorkspaceHeader', () => ({ WorkspaceHeader: () => null }));
vi.mock('@/components/workspace/WorkspaceModeTabs', () => ({ WorkspaceModeTabs: () => null }));
vi.mock('@/components/workspace/results/HistoryJobList', () => ({ HistoryJobList: () => null }));
vi.mock('@/components/workspace/PromptGalleryAccess', () => ({
  PromptGalleryAccessDialog: () => null,
  usePromptGalleryAccess: () => ({
    showPromptGallery: false,
    handlePromptGalleryEntry: vi.fn(),
    passwordDialogOpen: false,
    passwordInput: '',
    setPasswordInput: vi.fn(),
    setPasswordDialogOpen: vi.fn(),
    handlePasswordSubmit: vi.fn(),
  }),
}));
vi.mock('@/hooks/usePromptGalleryConfig', () => ({
  usePromptGalleryConfig: () => ({ mode: 'public', passwordEnabled: false }),
}));
vi.mock('@/hooks/useQueueStatus', () => ({ useQueueStatus: () => null }));
vi.mock('@/hooks/useWideMode', () => ({ useWideMode: () => ({ wideMode: false, toggleWideMode: vi.fn() }) }));
vi.mock('@/hooks/useServerTaskPolling', () => ({ useServerTaskPolling: vi.fn() }));
vi.mock('@/hooks/useWorkspaceJobs', () => ({
  useWorkspaceJobs: () => ({
    jobs: [],
    textJobs: [],
    imageJobs: [],
    loadedImages: new Map(),
    retryData: null,
    cancelJobId: null,
    hasApiKey: true,
    addJob: vi.fn(),
    replaceJob: vi.fn(),
    completeJob: vi.fn(),
    failJob: vi.fn(),
    getJob: vi.fn(),
    hasJob: vi.fn(),
    setRetryData: vi.fn(),
    setHasApiKey: vi.fn(),
    setCancelJobId: vi.fn(),
    clearJobsByMode: vi.fn(),
    retryDownload: vi.fn(),
    removeJob: vi.fn(),
    retryJob: vi.fn(),
  }),
}));
vi.mock('@/lib/image-actions', () => ({
  subscribeImageActionToasts: () => vi.fn(),
  subscribeUseAsImageReference: () => vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('WorkspaceShell Agent sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mounts.count = 0;
    mounts.lastSessionId = undefined;
    sessionApi.getActiveAgentSessionId.mockReturnValue('research');
    contextStore.setAgentSession.mockResolvedValue(undefined);
  });

  it('does not mount AgentChatWorkspace before the persisted session is ready', async () => {
    const ready = deferred<void>();
    contextStore.setAgentSession.mockReturnValueOnce(ready.promise);

    render(<WorkspaceShell />);

    expect(screen.queryByText(/agent-workspace/)).not.toBeInTheDocument();
    expect(contextStore.setAgentSession).toHaveBeenCalledWith('research');

    await act(async () => ready.resolve());

    expect(await screen.findByText('agent-workspace:research')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'session:research' })).toBeInTheDocument();
  });

  it('sets both session stores before publishing the active id and remounting AgentChatWorkspace', async () => {
    const calls: string[] = [];
    contextStore.setAgentSession.mockImplementation(async (id: string) => {
      calls.push(`context:${id}`);
    });
    sessionApi.setActiveAgentSessionId.mockImplementation((id: string) => {
      calls.push(`active:${id}`);
    });

    render(<WorkspaceShell />);
    expect(await screen.findByText('agent-workspace:research')).toBeInTheDocument();
    expect(mounts.count).toBe(1);
    expect(mounts.lastSessionId).toBe('research');
    calls.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'session:research' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'session:design' })).toBeInTheDocument());
    expect(calls).toEqual(['context:design', 'active:design']);
    expect(mounts.count).toBe(2);
    expect(mounts.lastSessionId).toBe('design');
  });
});
