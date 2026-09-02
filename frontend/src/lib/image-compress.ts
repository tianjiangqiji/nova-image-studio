/**
 * 上传前的图片压缩。
 *
 * 统一重编码为 WebP q=0.92：体积可控，肉眼几乎无差。严格说重编码有损，
 * 但浏览器里唯一真正无损的路径是重编码成 PNG，而那往往把 JPEG 改得更大，
 * 反而把本来合规的图顶到超限。
 *
 * GIF 例外：canvas 只能取到第一帧，重编码会把动图压成静图，所以原样放行。
 */

const WEBP_QUALITY = 0.92;
/** 单轮压缩后仍超限时的降采样步长 */
const DOWNSCALE_STEP = 0.85;
const MAX_DOWNSCALE_ROUNDS = 6;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败，文件可能已损坏'));
    img.src = url;
  });
}

function renameToWebp(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  const stem = idx > 0 ? fileName.slice(0, idx) : fileName;
  return `${stem}.webp`;
}

export interface CompressResult {
  file: File;
  /** 是否真的做了重编码（GIF 与不支持 canvas 的环境为 false） */
  compressed: boolean;
  originalBytes: number;
}

/**
 * 把图片重编码为 WebP。若结果仍超过 maxBytes，则逐步降分辨率重试；
 * 到上限仍不达标就抛错，让调用方给出明确提示而不是发一个必然被拒的请求。
 */
export async function compressImageToWebp(
  file: File,
  options: { maxBytes: number; quality?: number } = { maxBytes: Number.POSITIVE_INFINITY },
): Promise<CompressResult> {
  const originalBytes = file.size;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const quality = options.quality ?? WEBP_QUALITY;

  // GIF 动图重编码会只剩第一帧，直接放行；体积由调用方按原始大小判断
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  if (isGif || typeof document === 'undefined') {
    if (originalBytes > maxBytes) {
      throw new Error(`该图片 ${(originalBytes / 1024 / 1024).toFixed(1)}MB，超过上限且无法自动压缩，请手动压缩后重试`);
    }
    return { file, compressed: false, originalBytes };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const baseWidth = img.naturalWidth || img.width;
    const baseHeight = img.naturalHeight || img.height;
    if (!baseWidth || !baseHeight) {
      throw new Error('无法读取图片尺寸');
    }

    let scale = 1;
    for (let round = 0; round <= MAX_DOWNSCALE_ROUNDS; round++) {
      const width = Math.max(1, Math.round(baseWidth * scale));
      const height = Math.max(1, Math.round(baseHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器不支持 canvas，无法压缩图片');
      ctx.drawImage(img, 0, 0, width, height);

      const blob = await canvasToBlob(canvas, 'image/webp', quality);
      if (!blob) throw new Error('图片压缩失败');

      if (blob.size <= maxBytes) {
        return {
          file: new File([blob], renameToWebp(file.name), { type: 'image/webp' }),
          compressed: true,
          originalBytes,
        };
      }
      scale *= DOWNSCALE_STEP;
    }

    throw new Error(`该图片压缩后仍超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB，请先手动压缩或裁剪`);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
