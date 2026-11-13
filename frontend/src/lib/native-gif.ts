export const DEFAULT_NATIVE_GIF_FRAME_COUNT = 9;
export const DEFAULT_NATIVE_GIF_FRAME_DURATION_MS = 200;
export const MIN_NATIVE_GIF_FRAME_COUNT = 2;
export const MAX_NATIVE_GIF_FRAME_COUNT = 16;
export const MIN_NATIVE_GIF_FRAME_DURATION_MS = 20;
export const MAX_NATIVE_GIF_FRAME_DURATION_MS = 2000;

function isValidFrameCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_NATIVE_GIF_FRAME_COUNT && value <= MAX_NATIVE_GIF_FRAME_COUNT;
}

function isValidFrameDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_NATIVE_GIF_FRAME_DURATION_MS && value <= MAX_NATIVE_GIF_FRAME_DURATION_MS;
}

export function getNativeGifParamsError(frameCount: unknown, frameDurationMs: unknown): string | undefined {
  if (!isValidFrameCount(frameCount)) return 'GIF 帧数须为 2–16 的整数。';
  if (!isValidFrameDuration(frameDurationMs)) return 'GIF 每帧时长须为 20–2000 毫秒的整数。';
  return undefined;
}

export function normalizeNativeGifParams(frameCount: unknown, frameDurationMs: unknown) {
  return {
    gifFrameCount: isValidFrameCount(frameCount) ? frameCount : DEFAULT_NATIVE_GIF_FRAME_COUNT,
    gifFrameDurationMs: isValidFrameDuration(frameDurationMs)
      ? Math.round(frameDurationMs / 10) * 10 : DEFAULT_NATIVE_GIF_FRAME_DURATION_MS,
  };
}

/** Count actual image descriptors, skipping compressed sub-blocks and extensions. */
export function countGifFrames(bytes: Uint8Array): number | null {
  if (bytes.length < 13 || !/^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6)))) return null;
  let offset = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let frames = 0;
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) return true;
      offset += size;
    }
    return false;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames;
    if (marker === 0x21) {
      offset++; // extension label
      if (!skipBlocks()) return null;
    } else if (marker === 0x2c) {
      if (offset + 9 > bytes.length) return null;
      const packed = bytes[offset + 8];
      offset += 9 + ((packed & 128) ? 3 * (1 << ((packed & 7) + 1)) : 0);
      offset++; // LZW minimum code size
      if (!skipBlocks()) return null;
      frames++;
    } else return null;
  }
  return null;
}

export async function inspectNativeGif(blob: Blob): Promise<{ mimeType: string; frameCount?: number; warning?: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const frameCount = countGifFrames(bytes);
  if (frameCount !== null && frameCount > 0) {
    return {
      mimeType: 'image/gif', frameCount,
      warning: frameCount === 1 ? '上游返回了单帧 GIF，没有可播放的动画。已保留原始文件。' : undefined,
    };
  }
  const mimeType = blob.type || 'application/octet-stream';
  const label = mimeType.split('/')[1]?.toUpperCase() || '未知格式';
  return { mimeType, warning: `上游返回的是 ${label}，不是有效的多帧 GIF。已保留原始结果，未进行切图；可关闭原生 GIF 模式后重新生成网格图。` };
}

export function buildNativeGifPrompt(input: { prompt: string; loop: boolean; closedLoop: boolean }): string {
  return `${input.prompt.trim()}\n\n生成一段动作连贯的 GIF 动画。${input.closedLoop ? '首尾动作无缝衔接。' : ''}${input.loop ? '循环播放。' : '播放一次。'}`;
}
