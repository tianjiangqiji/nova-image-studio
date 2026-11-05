/**
 * 文本生图 / 图生图 共享的表单设置类型
 * 两个表单（TextToImageForm、ImageToImageForm）的设置字段完全一致，
 * 统一定义于此避免重复。
 */

import type { ModelId } from '@/lib/gemini-config';
import type { OutputSize, AspectRatio } from '@/lib/job-store';
import type { GptImageOutputFormat, GptImageBackground, GptImageQuality, GptImageStyle, ParallelCount } from '@/lib/model-capabilities';

export interface ImageFormSettings {
  model: ModelId;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  gptImageOutputFormat?: GptImageOutputFormat;
  parallelCount: ParallelCount;
}
