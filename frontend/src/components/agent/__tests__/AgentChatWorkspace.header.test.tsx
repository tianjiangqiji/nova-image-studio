import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatWorkspace } from '../AgentChatWorkspace';

vi.mock('@/hooks/useAgentChat', () => ({
  useAgentChat: () => ({
    messages: [],
    images: [],
    phase: 'idle',
    ready: true,
    hasApiKey: true,
    sendMessage: vi.fn(),
    clearContext: vi.fn(),
  }),
}));

vi.mock('@/lib/gemini-config', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/gemini-config')>();
  return {
    ...actual,
    loadGeminiConfig: () => ({}),
  };
});

vi.mock('@/lib/agent-context-store', () => ({
  getAgentImageBytes: vi.fn(),
}));

describe('AgentChatWorkspace Header', () => {
  it('在 Agent 标题左侧渲染侧边栏触发按钮并支持点击', () => {
    const onToggleSidebar = vi.fn();
    render(
      <AgentChatWorkspace
        activeSessionId="default"
        onToggleSidebar={onToggleSidebar}
      />
    );

    const toggleButton = screen.getByRole('button', { name: '打开会话列表' });
    expect(toggleButton).toBeInTheDocument();
    expect(toggleButton).toHaveClass('md:hidden');

    fireEvent.click(toggleButton);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
