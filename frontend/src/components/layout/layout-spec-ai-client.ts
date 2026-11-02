'use client';

// 构图规范 AI 生成客户端（开源版）
// 开源版文本模型走 nova 的默认文本模型注册表，需要显式传 baseUrl。

import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';

export interface LayoutSpecGenerateCallbacks {
  onDelta(token: string): void;
  onDone(fullText: string): void;
  onError(err: Error): void;
}

export interface LayoutSpecGenerateHandle {
  abort(): void;
  promise: Promise<void>;
}

export const LAYOUT_SPEC_MISSING_KEY_MESSAGE = '请先在设置中完成默认文本模型配置，配置完成后即可使用 AI 生成构图。';

/** 是否具备调用 AI 生成构图的鉴权条件 */
export function canGenerateLayoutSpec(): boolean {
  try {
    requireDefaultConfiguredTextModel('promptOptimize');
    return true;
  } catch {
    return false;
  }
}

export function generateLayoutSpec(
  intent: string,
  callbacks: LayoutSpecGenerateCallbacks,
): LayoutSpecGenerateHandle {
  let textModel: ReturnType<typeof requireDefaultConfiguredTextModel>;
  try {
    textModel = requireDefaultConfiguredTextModel('promptOptimize');
  } catch {
    callbacks.onError(new Error(LAYOUT_SPEC_MISSING_KEY_MESSAGE));
    return { abort: () => {}, promise: Promise.resolve() };
  }

  const handle: StreamPromptOptimizeHandle = streamPromptOptimize(
    { apiKey: textModel.apiKey, model: textModel.id, mode: 'layout-spec', prompt: intent },
    {
      onDelta: callbacks.onDelta,
      onDone: callbacks.onDone,
      onError: callbacks.onError,
    },
    textModel.baseUrl,
  );

  return { abort: handle.abort, promise: handle.promise };
}
