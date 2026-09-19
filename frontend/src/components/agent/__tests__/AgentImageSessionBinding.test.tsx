import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentImageGallery } from '../AgentImageGallery';
import { AgentMessageBubble } from '../AgentMessageBubble';
import type { AgentImageRecord, AgentMessage } from '@/lib/agent-chat-config';

const agentStore = vi.hoisted(() => ({
  getAgentImageBytes: vi.fn(),
}));
const actionState = vi.hoisted(() => ({
  payloads: [] as Array<{ sessionId?: string }>,
}));

vi.mock('@/lib/agent-context-store', () => agentStore);
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock('@/components/workspace/results/HistoryImagePreview', () => ({
  HistoryImagePreview: () => <div data-testid="history-image-preview" />,
}));
vi.mock('@/components/workspace/results/ImageHoverActions', () => ({
  ImageHoverActions: ({ payload }: { payload: { sessionId?: string } }) => {
    actionState.payloads.push(payload);
    return <div data-testid="image-hover-action" data-session-id={payload.sessionId || ''} />;
  },
}));

const image: AgentImageRecord = {
  imgId: 'img_1',
  source: 'generated',
  thumbnail: 'data:image/png;base64,AA==',
  description: '测试图片',
  mimeType: 'image/png',
  createdAt: 1,
};

const message: AgentMessage = {
  id: 'message-1',
  role: 'assistant',
  text: '图片结果',
  imageIds: ['img_1'],
  createdAt: 1,
};

describe('Agent image UI session binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionState.payloads = [];
    agentStore.getAgentImageBytes.mockResolvedValue(null);
  });

  it('uses the active session when opening a gallery preview and its actions', async () => {
    render(<AgentImageGallery images={[image]} sessionId="session-a" />);

    fireEvent.click(screen.getByRole('button', { name: /此对话包含的图片/ }));
    expect(await screen.findByTestId('image-hover-action')).toHaveAttribute('data-session-id', 'session-a');
    fireEvent.click(screen.getByRole('button', { name: /img_1img_1生成/ }));

    await waitFor(() => expect(agentStore.getAgentImageBytes).toHaveBeenCalledWith('img_1', 'session-a'));
  });

  it('uses the active session when opening a message image preview and its actions', async () => {
    render(
      <AgentMessageBubble
        message={message}
        imageMap={new Map([['img_1', image]])}
        sessionId="session-b"
        onWithdraw={vi.fn()}
      />,
    );

    expect(screen.getByTestId('image-hover-action')).toHaveAttribute('data-session-id', 'session-b');
    fireEvent.click(screen.getByRole('button', { name: 'img_1' }));

    await waitFor(() => expect(agentStore.getAgentImageBytes).toHaveBeenCalledWith('img_1', 'session-b'));
  });

  it('wraps long user URLs instead of overflowing the bubble', () => {
    const longUrl = 'https://item.taobao.com/item.htm?spm=a21dvs.23580594.0.0.275c2c1bf9ncCC&ft=t&id=1080264259614口9333';
    render(
      <AgentMessageBubble
        message={{ id: 'user-1', role: 'user', text: longUrl, createdAt: 1 }}
        imageMap={new Map()}
        sessionId="session-b"
        onWithdraw={vi.fn()}
      />,
    );

    const bubble = screen.getByText(longUrl);
    expect(bubble.className).toMatch(/break-all/);
    expect(bubble.className).toMatch(/min-w-0/);
    expect(bubble.parentElement?.className).toMatch(/min-w-0/);
  });
});
