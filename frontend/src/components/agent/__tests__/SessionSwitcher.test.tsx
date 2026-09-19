import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSwitcher } from '../SessionSwitcher';

const sessionApi = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
  createAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
}));
const contextStore = vi.hoisted(() => ({
  deleteAgentSessionDatabase: vi.fn(),
}));

vi.mock('@/lib/agent-sessions', () => sessionApi);
vi.mock('@/lib/agent-context-store', () => contextStore);

const defaultSession = { id: 'default', name: '默认会话' };
const designSession = { id: 'design', name: '设计草稿' };

describe('SessionSwitcher sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionApi.listAgentSessions.mockReturnValue([defaultSession, designSession]);
    sessionApi.createAgentSession.mockImplementation((name: string) => ({ id: 'new-session', name }));
    sessionApi.renameAgentSession.mockImplementation((id: string, name: string) => ({ id, name }));
    sessionApi.deleteAgentSession.mockImplementation(() => undefined);
    contextStore.deleteAgentSessionDatabase.mockResolvedValue(undefined);
  });

  it('always renders the session list with a prominent create button instead of a hidden dropdown', () => {
    render(<SessionSwitcher activeSessionId="default" onSessionChange={vi.fn()} />);

    expect(screen.getByRole('complementary', { name: 'Agent 会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '默认会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设计草稿' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '切换 Agent 会话' })).not.toBeInTheDocument();
  });

  it('selects another session through the caller before changing the visible active session', async () => {
    const onSessionChange = vi.fn().mockResolvedValue(undefined);

    render(<SessionSwitcher activeSessionId="default" onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole('button', { name: '设计草稿' }));

    expect(onSessionChange).toHaveBeenCalledWith('design');
    expect(screen.getByRole('button', { name: '默认会话' })).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(onSessionChange).toHaveBeenCalledTimes(1));
  });

  it('creates a named session, refreshes the list, and switches into it', async () => {
    const onSessionChange = vi.fn().mockResolvedValue(undefined);
    render(<SessionSwitcher activeSessionId="default" onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    const dialog = await screen.findByRole('dialog', { name: '新建会话' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '会话名称' }), {
      target: { value: '新的工作流' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(sessionApi.createAgentSession).toHaveBeenCalledWith('新的工作流'));
    expect(sessionApi.listAgentSessions).toHaveBeenCalledTimes(2);
    expect(onSessionChange).toHaveBeenCalledWith('new-session');
  });

  it('renames a session from its row action', async () => {
    render(<SessionSwitcher activeSessionId="design" onSessionChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重命名会话 设计草稿' }));

    const dialog = await screen.findByRole('dialog', { name: '重命名会话' });
    const input = within(dialog).getByRole('textbox', { name: '会话名称' });
    expect(input).toHaveValue('设计草稿');
    fireEvent.change(input, { target: { value: '最终稿' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(sessionApi.renameAgentSession).toHaveBeenCalledWith('design', '最终稿'));
    expect(sessionApi.listAgentSessions).toHaveBeenCalledTimes(2);
  });

  it('does not offer deletion for the default session', () => {
    render(<SessionSwitcher activeSessionId="default" onSessionChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '删除会话 默认会话' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除会话 设计草稿' })).toBeInTheDocument();
  });

  it('switches to default before deleting the active session database and registry entry', async () => {
    const calls: string[] = [];
    const onSessionChange = vi.fn().mockImplementation(async () => {
      calls.push('switch');
    });
    contextStore.deleteAgentSessionDatabase.mockImplementation(async () => {
      calls.push('database');
    });
    sessionApi.deleteAgentSession.mockImplementation(() => {
      calls.push('registry');
      return true;
    });
    render(<SessionSwitcher activeSessionId="design" onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole('button', { name: '删除会话 设计草稿' }));

    const dialog = await screen.findByRole('dialog', { name: '删除会话' });
    expect(dialog).toHaveTextContent('确定删除设计草稿吗？');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(sessionApi.deleteAgentSession).toHaveBeenCalledWith('design'));
    expect(onSessionChange).toHaveBeenCalledWith('default');
    expect(contextStore.deleteAgentSessionDatabase).toHaveBeenCalledWith('design');
    expect(calls).toEqual(['switch', 'database', 'registry']);
  });

  it('deletes an inactive session without touching the active session', async () => {
    const onSessionChange = vi.fn().mockResolvedValue(undefined);
    render(<SessionSwitcher activeSessionId="default" onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole('button', { name: '删除会话 设计草稿' }));

    const dialog = await screen.findByRole('dialog', { name: '删除会话' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(sessionApi.deleteAgentSession).toHaveBeenCalledWith('design'));
    expect(contextStore.deleteAgentSessionDatabase).toHaveBeenCalledWith('design');
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(sessionApi.listAgentSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps the registry entry, restores the old session, and reports an error when deletion fails', async () => {
    const onSessionChange = vi.fn().mockResolvedValue(undefined);
    contextStore.deleteAgentSessionDatabase.mockRejectedValue(new Error('IndexedDB blocked'));
    render(<SessionSwitcher activeSessionId="design" onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole('button', { name: '删除会话 设计草稿' }));

    const dialog = await screen.findByRole('dialog', { name: '删除会话' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('删除会话失败，请重试。');
    expect(onSessionChange.mock.calls.map(([id]) => id)).toEqual(['default', 'design']);
    expect(sessionApi.deleteAgentSession).not.toHaveBeenCalled();
    expect(sessionApi.listAgentSessions).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
  });

  it('disables sidebar actions while a session operation is busy', async () => {
    let finishSwitch: (() => void) | undefined;
    const onSessionChange = vi.fn(() => new Promise<void>(resolve => {
      finishSwitch = resolve;
    }));
    render(<SessionSwitcher activeSessionId="default" onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    const dialog = await screen.findByRole('dialog', { name: '新建会话' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '会话名称' }), {
      target: { value: '新的工作流' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(onSessionChange).toHaveBeenCalledWith('new-session'));
    expect(screen.getByRole('button', { name: '新建会话' })).toBeDisabled();
    finishSwitch?.();
    await waitFor(() => expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled());
  });

  it('opens and closes the mobile sidebar drawer when triggered', () => {
    const onSessionChange = vi.fn();
    const onMobileOpenChange = vi.fn();
    const { rerender } = render(
      <SessionSwitcher
        activeSessionId="default"
        onSessionChange={onSessionChange}
        mobileOpen={true}
        onMobileOpenChange={onMobileOpenChange}
      />
    );

    const drawer = screen.getByRole('dialog', { name: '会话侧边栏' });
    expect(drawer).toBeInTheDocument();

    const closeBtn = within(drawer).getByRole('button', { name: '关闭侧边栏' });
    fireEvent.click(closeBtn);
    expect(onMobileOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <SessionSwitcher
        activeSessionId="default"
        onSessionChange={onSessionChange}
        mobileOpen={false}
        onMobileOpenChange={onMobileOpenChange}
      />
    );
    expect(screen.queryByRole('dialog', { name: '会话侧边栏' })).not.toBeInTheDocument();
  });

  it('selects a session and closes drawer on mobile', async () => {
    const onSessionChange = vi.fn().mockResolvedValue(undefined);
    const onMobileOpenChange = vi.fn();
    render(
      <SessionSwitcher
        activeSessionId="default"
        onSessionChange={onSessionChange}
        mobileOpen={true}
        onMobileOpenChange={onMobileOpenChange}
      />
    );

    const drawer = screen.getByRole('dialog', { name: '会话侧边栏' });

    await act(async () => {
      fireEvent.click(within(drawer).getByRole('button', { name: '设计草稿' }));
    });
    expect(onSessionChange).toHaveBeenCalledWith('design');
    expect(onMobileOpenChange).toHaveBeenCalledWith(false);
  });
});
