import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentProposalCard } from '../AgentProposalCard';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import { saveRegistry } from '@/lib/nova-models';
import type { AgentImageRecord, AgentProposal } from '@/lib/agent-chat-config';

const MODEL_ID = 'gemini-3-pro-image-preview';

function image(imgId: string, productKey: string): AgentImageRecord {
  return {
    imgId,
    source: 'uploaded',
    thumbnail: `data:image/png;base64,${imgId}`,
    description: `${productKey} 图片`,
    mimeType: 'image/png',
    productKey,
    createdAt: Number(imgId.replace(/\D/g, '')) || 1,
  };
}

function proposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    action: 'generate',
    prompt: '横版商品宣传图',
    referencedImageIds: ['img-a1'],
    reason: '测试提案',
    productKey: 'product-a',
    requestedAspectRatio: '9:16',
    ...overrides,
  };
}

function renderCard(overrides: Partial<ComponentProps<typeof AgentProposalCard>> = {}) {
  const onApprove = vi.fn();
  const props: ComponentProps<typeof AgentProposalCard> = {
    proposal: proposal(),
    images: [image('img-a1', 'product-a'), image('img-b1', 'product-b')],
    imageModel: MODEL_ID,
    onModelChange: vi.fn(),
    onApprove,
    onCancel: vi.fn(),
    ...overrides,
  };
  return { onApprove, ...render(<AgentProposalCard {...props} />) };
}

beforeEach(() => {
  saveRegistry({
    imageModels: [{
      id: MODEL_ID,
      protocol: 'google',
      name: 'Banana Pro',
      modelId: MODEL_ID,
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
      builtinPreset: MODEL_ID,
      maxRefImages: 14,
      maxOutputSize: '4K',
      supportsAdvancedParams: false,
    }],
    textModels: [],
    defaults: {
      textToImage: MODEL_ID,
      imageToImage: MODEL_ID,
      reversePrompt: '',
      agent: '',
      promptOptimize: '',
      imageDescribe: '',
      sliceDecomposition: '',
      sliceReconstruct: '',
      sliceImageEdit: '',
    },
  });
  syncDynamicModelExports();
});

describe('AgentProposalCard', () => {
  it('生成提案自动勾选所属商品的全部图片，并隐藏其他商品图片', () => {
    renderCard({
      images: [
        image('img-a1', 'product-a'),
        image('img-a2', 'product-a'),
        image('img-b1', 'product-b'),
      ],
    });

    expect(screen.getByText('参考图生成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许并生成' })).toBeInTheDocument();
    expect(screen.queryByText('编辑图片')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许并改图' })).not.toBeInTheDocument();
    expect(screen.getByText('已选 2 / 上限 14')).toBeInTheDocument();
    expect(screen.getByAltText('img-a1')).toBeInTheDocument();
    expect(screen.getByAltText('img-a2')).toBeInTheDocument();
    expect(screen.queryByAltText('img-b1')).not.toBeInTheDocument();
  });

  it('确认时提示词保持模型原文，比例只走 params', () => {
    const { onApprove } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: '允许并生成' }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    const [prompt, , , params] = onApprove.mock.calls[0];
    expect(prompt).not.toContain('画面比例');
    expect(params.aspectRatio).toBe('9:16');
  });

  it('允许并生成按钮带 data-agent-approve，方便滚动对齐', () => {
    renderCard();
    expect(screen.getByRole('button', { name: '允许并生成' })).toHaveAttribute('data-agent-approve');
  });

  it('失败后显示可重试文案，不再写等待确认', () => {
    renderCard({ failed: true });

    expect(screen.getByText('生成失败，可修改后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试生成' })).toBeInTheDocument();
    expect(screen.queryByText('等待你确认')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许并生成' })).not.toBeInTheDocument();
  });
});
