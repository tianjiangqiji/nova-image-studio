const MAX_MARKUP_PIXELS = 16_777_216;
const MAX_MARKUP_BYTES = 50 * 1024 * 1024;

function supportsGptImageMarkup(model) {
  // 用户配置的是实际上游模型，不按代理商的 Pro/Cheap/Tokens SKU 缩减能力。
  return /^gpt-image-2\.[56](?:-|$)/i.test(String(model || ''));
}

function readPng(image, label) {
  if (image?.mimeType !== 'image/png' || typeof image.data !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0) {
    throw new Error(`${label}必须是有效的 PNG 图片`);
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length < 33 || bytes.readBigUInt64BE(0) !== 0x89504e470d0a1a0an
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${label}必须是有效的 PNG 图片`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_MARKUP_PIXELS) {
    throw new Error(`${label}不能超过 ${MAX_MARKUP_PIXELS.toLocaleString('en-US')} 像素`);
  }
  return { bytes, width, height };
}

function validateGptImageMarkup(request) {
  if (request.gptImageMarkup == null) return;
  if (request.protocol !== 'openai' || !supportsGptImageMarkup(request.model)) {
    throw new Error('当前模型不支持 Markup 标注编辑');
  }
  if (request.mode !== 'image-to-image' || !request.images?.length) {
    throw new Error('Markup 标注编辑需要首张参考图');
  }
  if (request.mask != null || request.prompt_rewriter != null || request.promptRewriter != null) {
    throw new Error('Markup 不能与 mask 或 prompt_rewriter 同时使用');
  }
  // 首图由浏览器按显示方向导出原尺寸 PNG，避免 EXIF 方向与覆盖层不一致。
  const original = readPng(request.images[0], '标注首图');
  const markup = readPng(request.gptImageMarkup, '标注图层');
  if (markup.bytes.length > MAX_MARKUP_BYTES) throw new Error('标注图层不能超过 50MB');
  if (original.width !== markup.width || original.height !== markup.height) {
    throw new Error('标注图层尺寸必须与首张参考图完全一致');
  }
  if (markup.bytes[25] !== 6 && markup.bytes[25] !== 4) {
    throw new Error('标注图层必须包含透明通道');
  }
}

module.exports = { supportsGptImageMarkup, validateGptImageMarkup };
