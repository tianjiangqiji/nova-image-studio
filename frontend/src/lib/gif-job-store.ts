import { isGptImageModel } from '@/lib/gemini-config';
import type { RefImageData } from '@/lib/job-store';
import { supportsNativeImageOutput, supportsCustomSize, type GptImageBackground, type GptImageQuality, type GptImageStyle } from '@/lib/model-capabilities';
import { getDefaultImageModel, getCompleteImageModels, loadRegistry } from '@/lib/nova-models';

export type GifModel = string;

export type GifStatus =
  | 'idle'
  | 'generating_grid'
  | 'review_grid'
  | 'generating_gif'
  | 'done'
  | 'failed';

export interface ActiveGifJob {
  id: string;
  status: GifStatus;
  prompt: string;
  loop: boolean;
  closedLoop: boolean;
  model: string;
  nativeGif?: boolean;
  gifFrameCount?: number;
  gifFrameDurationMs?: number;
  resultMimeType?: string;
  resultFrameCount?: number;
  warning?: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  refImages: RefImageData[];
  serverTaskId?: string;
  gridImageRef?: string;
  frameDelayMs: number;
  loopCount: number;
  framePadding: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'nova-gif-active-job';
const TEMPLATE_URL = '/togif.png';

export const GIF_MAX_REF_IMAGES = 6;
export const GIF_DEFAULT_FRAME_DELAY_MS = 120;
export const GIF_DEFAULT_LOOP_COUNT = 0;
export const GIF_DEFAULT_FRAME_PADDING = 1.5;
export const GIF_MAX_FRAME_PADDING = 5;
export const GIF_GRID_CUSTOM_SIZE = '3264x2448';
export const GIF_GRID_OUTPUT_SIZE = '2K' as const;
export const GIF_GRID_ASPECT_RATIO = '4:3' as const;
export const GIF_GRID_COLS = 4;
export const GIF_GRID_ROWS = 3;
export const GIF_FRAME_COUNT = GIF_GRID_COLS * GIF_GRID_ROWS;

export function loadActiveGifJob(): ActiveGifJob | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveGifJob;
    if (!parsed || typeof parsed.id !== 'string' || !parsed.status) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveActiveGifJob(job: ActiveGifJob | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!job) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
  } catch {
    // storage quota / privacy mode — keep working with in-memory state only
  }
}

let cachedTemplate: { data: string; mimeType: string } | null = null;
let inflightTemplate: Promise<{ data: string; mimeType: string }> | null = null;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.substring(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取模板图失败'));
    reader.readAsDataURL(blob);
  });
}

export async function loadGifTemplate(): Promise<{ data: string; mimeType: string }> {
  if (cachedTemplate) return cachedTemplate;
  if (inflightTemplate) return inflightTemplate;

  inflightTemplate = (async () => {
    const response = await fetch(TEMPLATE_URL, { cache: 'force-cache' });
    if (!response.ok) {
      inflightTemplate = null;
      throw new Error(`无法加载排版模板图 (${response.status})`);
    }
    const blob = await response.blob();
    const data = await blobToBase64(blob);
    const result = { data, mimeType: blob.type || 'image/png' };
    cachedTemplate = result;
    inflightTemplate = null;
    return result;
  })();

  return inflightTemplate;
}

export function isActiveStatus(status: GifStatus): boolean {
  return status === 'generating_grid' || status === 'generating_gif';
}

export function needsOverwriteConfirm(job: ActiveGifJob | null): boolean {
  if (!job) return false;
  return job.status !== 'idle';
}

export function getGifCompatibleModels(): { value: GifModel; label: string }[] {
  const registry = loadRegistry();
  return getCompleteImageModels(registry)
    .filter((model) => supportsNativeImageOutput(model.id) || (isGptImageModel(model.id) && supportsCustomSize(model.id) && model.maxOutputSize === '4K'))
    .map((model) => ({ value: model.id, label: model.name }));
}

export function getDefaultGifModelId(): GifModel {
  const registry = loadRegistry();
  const options = getGifCompatibleModels();
  const preferred = getDefaultImageModel(registry, 'textToImage');
  if (preferred && options.some((option) => option.value === preferred.id)) {
    return preferred.id;
  }
  return options[0]?.value || '';
}
