import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ImageGenerationWorkbench } from '@/components/ImageGenerationWorkbench';
import { saveRegistry } from '@/lib/nova-models';
import { syncDynamicModelExports } from '@/lib/gemini-config';

beforeEach(() => {
  localStorage.clear();
  saveRegistry({
    imageModels: [{
      id: 'custom-sunburst', name: '自定义 Sunburst', protocol: 'openai',
      modelId: 'gpt-image-2.6-sunburst', baseUrl: 'https://images.example.test',
      apiKey: 'test-key', builtinPreset: 'gpt-image-2.6-sunburst', maxRefImages: 16,
      maxOutputSize: '4K', supportsAdvancedParams: true,
    }],
    textModels: [],
    defaults: {
      textToImage: 'custom-sunburst', imageToImage: 'custom-sunburst', reversePrompt: '',
      agent: '', promptOptimize: '', layoutSpec: '', imageDescribe: '',
      sliceDecomposition: '', sliceReconstruct: '', sliceImageEdit: '',
    },
  });
  syncDynamicModelExports();
});

describe('原生 SVG 工作台', () => {
  it('选择 SVG 后提交原生格式并保留模型及质量参数', async () => {
    const onSubmitText = vi.fn();
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={onSubmitText} onSubmitImage={onSubmitImage}
      initialData={{ model: 'custom-sunburst', prompt: '绿色蔬菜矢量图标', gptImageQuality: 'high' }} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('switch', { name: /SVG 矢量图/ }));
    fireEvent.click(screen.getByTitle('按文生图提交'));
    expect(onSubmitText).toHaveBeenCalledWith(expect.objectContaining({
      prompts: ['绿色蔬菜矢量图标'], model: 'custom-sunburst', gptImageOutputFormat: 'svg',
      gptImageQuality: 'high',
    }));
    expect(onSubmitImage).not.toHaveBeenCalled();
  });

  it('恢复带参考图的旧 SVG 草稿时明确提示，关闭 SVG 后可以普通编辑', async () => {
    const onSubmitText = vi.fn();
    const onSubmitImage = vi.fn();
    const refImage = { id: 'ref-1', name: 'sample.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQ==' };
    render(<ImageGenerationWorkbench onSubmitText={onSubmitText} onSubmitImage={onSubmitImage}
      initialData={{ model: 'custom-sunburst', prompt: '编辑参考图', gptImageOutputFormat: 'svg', refImages: [refImage] }} />);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('原生 SVG 仅支持文生图');
    expect(screen.getByTitle('按图生图提交')).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText('描述如何调整参考图...'), { key: 'Enter', shiftKey: true });
    expect(onSubmitImage).not.toHaveBeenCalled();
    expect(onSubmitText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: /SVG 矢量图/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({
      gptImageOutputFormat: 'png', files: [expect.objectContaining(refImage)],
    }));
  });
});
