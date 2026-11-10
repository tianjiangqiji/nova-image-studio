import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GifParametersPanel, type GifParametersPanelProps } from '@/components/gif/GifParametersPanel';

vi.mock('@/components/AttachmentChips', () => ({ AttachmentChips: () => null }));
vi.mock('@/components/GptImageAdvancedParamsControl', () => ({ GptImageAdvancedParamsControl: () => null }));

afterEach(cleanup);

const callbacks = {
  onPromptChange: vi.fn(), onModelPopoverOpenChange: vi.fn(), onModelChange: vi.fn(),
  onGptImageAdvancedParamsChange: vi.fn(), onClosedLoopToggle: vi.fn(), onRemoveRef: vi.fn(),
  onDrop: vi.fn(), onDragOver: vi.fn(), onDragLeave: vi.fn(), onFileSelect: vi.fn(),
  onSubmit: vi.fn(), onConfigureApiKey: vi.fn(), onOptimize: vi.fn(), onClear: vi.fn(),
};
function Harness({ generating = false, model = 'gpt-image-2.6-flare' }: { generating?: boolean; model?: GifParametersPanelProps['model'] }) {
  const [nativeGif, setNativeGif] = useState(model === 'gpt-image-2.6-flare');
  const [gifFrameCount, setGifFrameCount] = useState(9);
  const [gifFrameDurationMs, setGifFrameDurationMs] = useState(200);
  return <GifParametersPanel {...callbacks}
    nativeGif={nativeGif} onNativeGifChange={setNativeGif}
    gifFrameCount={gifFrameCount} onGifFrameCountChange={setGifFrameCount}
    gifFrameDurationMs={gifFrameDurationMs} onGifFrameDurationMsChange={setGifFrameDurationMs}
    prompt="猫眨眼" model={model} modelPopoverOpen={false}
    modelOptions={[{ value: model, label: model }]}
    gptImageAdvancedParams={{ quality: 'auto', style: 'auto', background: 'auto' }} closedLoop={false}
    refFiles={[]} maxedOut={false} isDragOver={false} uploading={false} uploadError={null}
    disabled={false} generating={generating} canSubmit={!generating} />;
}

describe('native GIF toolbar controls', () => {
  it('keeps timing controls in the toolbar, preserves edits across mode switches and restores grid upload', () => {
    const { container } = render(<Harness />);
    const toolbar = within(screen.getByRole('group', { name: '动图工具栏' }));
    expect(toolbar.getByRole('spinbutton', { name: 'GIF 帧数' })).toHaveValue(9);
    expect(toolbar.getByRole('spinbutton', { name: 'GIF 每帧时长（毫秒）' })).toHaveValue(200);
    expect(container.querySelector('input[type=file]')).toBeNull();
    fireEvent.change(toolbar.getByRole('spinbutton', { name: 'GIF 帧数' }), { target: { value: '12' } });
    fireEvent.change(toolbar.getByRole('spinbutton', { name: 'GIF 每帧时长（毫秒）' }), { target: { value: '80' } });
    fireEvent.click(toolbar.getByRole('switch', { name: /原生 GIF 模式/ }));
    expect(screen.queryByRole('group', { name: '原生 GIF 参数' })).toBeNull();
    expect(container.querySelector('input[type=file]')).not.toBeNull();
    fireEvent.click(toolbar.getByRole('switch', { name: /原生 GIF 模式/ }));
    expect(toolbar.getByRole('spinbutton', { name: 'GIF 帧数' })).toHaveValue(12);
    expect(toolbar.getByRole('spinbutton', { name: 'GIF 每帧时长（毫秒）' })).toHaveValue(80);
  });

  it('hides native controls for older models and disables edits during generation', () => {
    const { rerender } = render(<Harness model="gpt-image-2-pro" />);
    expect(screen.queryByRole('switch', { name: /原生 GIF 模式/ })).toBeNull();
    expect(screen.queryByRole('group', { name: '原生 GIF 参数' })).toBeNull();
    rerender(<Harness key="native" generating />);
    expect(screen.getByRole('switch', { name: /原生 GIF 模式/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('switch', { name: /原生 GIF 模式/ }));
    expect(screen.getByRole('switch', { name: /原生 GIF 模式/ })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'GIF 帧数' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'GIF 每帧时长（毫秒）' })).toBeDisabled();
  });

  it('retains invalid input, explains its range and disables submission instead of silently changing it', () => {
    render(<Harness />);
    const count = screen.getByRole('spinbutton', { name: 'GIF 帧数' });
    fireEvent.change(count, { target: { value: '' } });
    expect(count).toHaveValue(null);
    fireEvent.blur(count);
    expect(count).toHaveValue(null);
    expect(screen.getByRole('alert')).toHaveTextContent('2–16');
    expect(screen.getByRole('button', { name: '生成原生 GIF' })).toBeDisabled();
    fireEvent.change(count, { target: { value: '9' } });
    const duration = screen.getByRole('spinbutton', { name: 'GIF 每帧时长（毫秒）' });
    fireEvent.change(duration, { target: { value: '-1' } });
    fireEvent.blur(duration);
    expect(duration).toHaveValue(-1);
    expect(screen.getByRole('alert')).toHaveTextContent('20–2000');
    expect(screen.getByRole('button', { name: '生成原生 GIF' })).toBeDisabled();
    fireEvent.change(duration, { target: { value: '25' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '生成原生 GIF' })).toBeEnabled();
  });
});
