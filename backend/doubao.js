// 豆包 Seedream（火山方舟 ark）图片生成协议适配。
// 与 openai 协议的差异：
//   1. 端点固定为 /v3/images/generations（套餐版路径前缀 /api/plan/v3）
//   2. 图生图不走 /images/edits，而是在 generations 里传 image 参数（data URL 数组）
//   3. seedream-5.0-lite 最小输出像素 3,686,400（约 1920x1920），1K 会被拒
const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api';
const MIN_OUTPUT_PIXELS = 3686400;
const MAX_OUTPUT_PIXELS = 4096 * 4096;
const SIZE_MULTIPLE = 16;

// baseUrl 允许填到 /api、/api/v3、/api/plan/v3 任意一级；统一归一到 images/generations。
// 已含 /v3/images/generations 或末尾 /images/generations 时不再拼一层。
function buildDoubaoImagesUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/(?:v\d+\/)?images\/generations$/i.test(trimmed)) return trimmed;
  const withoutVersion = trimmed.replace(/\/v\d+$/i, '');
  const base = withoutVersion || DEFAULT_ARK_BASE_URL;
  return `${base}/v3/images/generations`;
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ''));
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

const MAX_SIDE = 4096;
const alignUp = (value) => Math.ceil(value / SIZE_MULTIPLE) * SIZE_MULTIPLE;
const alignDown = (value) => Math.max(SIZE_MULTIPLE, Math.floor(value / SIZE_MULTIPLE) * SIZE_MULTIPLE);

// 把 gpt-image 风格的 WxH 尺寸钳制到 seedream 允许的像素区间（保持比例）。
// 总像素达标后若任一边 >4096，按比例缩到 max(side)=4096 再 16 对齐；
// 若因此跌破下限则抬短边（仍 ≤4096），仍不够则拒绝。
function clampSizeToPixelRange(size) {
  const parsed = parseSize(size);
  if (!parsed) return null;
  let { width, height } = parsed;
  const pixels = width * height;
  if (pixels < MIN_OUTPUT_PIXELS || pixels > MAX_OUTPUT_PIXELS) {
    const scale = pixels < MIN_OUTPUT_PIXELS
      ? Math.sqrt(MIN_OUTPUT_PIXELS / pixels)
      : Math.sqrt(MAX_OUTPUT_PIXELS / pixels);
    // 对齐 16 倍数时的舍入方向必须和缩放方向一致：
    // 放大时向下取整可能让总像素跌破下限（1024x1360 → 1664x2208 = 3,674,112 < 3,686,400），
    // 上游随即报 "image size must be at least 3686400 pixels"。
    const align = pixels < MIN_OUTPUT_PIXELS ? alignUp : alignDown;
    width = align(width * scale);
    height = align(height * scale);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(width, height);
    width *= scale;
    height *= scale;
    if (width >= height) {
      width = MAX_SIDE;
      height = alignDown(height);
    } else {
      height = MAX_SIDE;
      width = alignDown(width);
    }
  }
  if (width * height < MIN_OUTPUT_PIXELS) {
    const bumped = alignUp(MIN_OUTPUT_PIXELS / Math.max(width, height));
    if (bumped > MAX_SIDE) return null;
    if (width <= height) width = bumped;
    else height = bumped;
    if (width * height < MIN_OUTPUT_PIXELS) return null;
  }
  return `${width}x${height}`;
}

// resolvedSize 为空（auto/比例未给）时按档位兜底：seedream 5.0-lite 最小 2K
function resolveDoubaoImageSize(request, resolveBaseSize) {
  const baseSize = typeof resolveBaseSize === 'function' ? resolveBaseSize(request) : undefined;
  const clamped = clampSizeToPixelRange(baseSize);
  if (clamped) return clamped;
  return request.outputSize === '4K' ? '4K' : '2K';
}

// 请求体：文生图与图生图共用 generations 端点；参考图走 image 参数（data URL 数组）
// 豆包 Seedream 系列参考图限制：
//   - seedream-5.0-pro: 最多 10 张
//   - seedream-5.0-lite / 4.5 / 4.0: 最多 14 张（最宽松）
function buildDoubaoImagePayload(request, size) {
  const payload = {
    model: request.model,
    prompt: request.prompt,
    response_format: 'b64_json',
    watermark: false,
  };
  if (size) payload.size = size;

  if (Array.isArray(request.images) && request.images.length > 0) {
    // 根据模型判断参考图数量限制
    const modelId = String(request.model || '').toLowerCase();
    let maxImages = 14; // 默认 Seedream 5.0 Lite / 4.5 / 4.0 限制
    let modelName = 'Seedream 5.0 Lite';

    if (modelId.includes('5.0-pro') || modelId.includes('5-0-pro')) {
      maxImages = 10;
      modelName = 'Seedream 5.0 Pro';
    }

    if (request.images.length > maxImages) {
      throw new Error(
        `豆包 ${modelName} 最多支持 ${maxImages} 张参考图，` +
        `当前提供了 ${request.images.length} 张。` +
        `建议：${maxImages === 10 ? '切换到 Seedream 5.0 Lite（支持 14 张）；' : ''}减少参考图数量或分批生成。`
      );
    }

    payload.image = request.images.map(img => `data:${img.mimeType || 'image/png'};base64,${img.data}`);
  }
  return payload;
}

module.exports = {
  DEFAULT_ARK_BASE_URL,
  MIN_OUTPUT_PIXELS,
  MAX_OUTPUT_PIXELS,
  buildDoubaoImagesUrl,
  clampSizeToPixelRange,
  resolveDoubaoImageSize,
  buildDoubaoImagePayload,
};
