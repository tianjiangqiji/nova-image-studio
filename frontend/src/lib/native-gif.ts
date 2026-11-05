export const DEFAULT_NATIVE_GIF_FRAME_COUNT = 20;
export const DEFAULT_NATIVE_GIF_FRAME_DURATION_MS = 200;

export function normalizeNativeGifParams(frameCount: unknown, frameDurationMs: unknown) {
  const positiveInteger = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    gifFrameCount: positiveInteger(frameCount, DEFAULT_NATIVE_GIF_FRAME_COUNT),
    gifFrameDurationMs: positiveInteger(frameDurationMs, DEFAULT_NATIVE_GIF_FRAME_DURATION_MS),
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
