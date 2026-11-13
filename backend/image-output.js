const MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
};

function isSvgText(text) {
  return /^<svg(?:\s|>)/i.test(text.replace(/^\uFEFF/, '').trimStart()
    .replace(/^(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)+/i, ''));
}

function detectImageMime(bytes, fallback = 'image/png') {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (isSvgText(bytes.toString('utf8', 0, Math.min(bytes.length, 4096)))) return 'image/svg+xml';
  const mime = String(fallback).split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[mime] ? mime : 'image/png';
}

function decodeImagePayload(value) {
  if (isSvgText(value)) return { bytes: Buffer.from(value, 'utf8'), mimeType: 'image/svg+xml' };
  const dataUrl = value.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
  const bytes = dataUrl
    ? (dataUrl[2] ? Buffer.from(dataUrl[3].replace(/\s/g, ''), 'base64') : Buffer.from(decodeURIComponent(dataUrl[3]), 'utf8'))
    : Buffer.from(value.replace(/\s/g, ''), 'base64');
  return { bytes, mimeType: detectImageMime(bytes, dataUrl?.[1]) };
}

function getImageExtension(mime) { return MIME_EXTENSIONS[mime] || 'png'; }

function supportsNativeImageOutput(model) {
  return /^gpt-image-2\.6(?:-|$)/i.test(model);
}

function validateImageOutput(request) {
  const format = request.gptImageOutputFormat || 'png';
  if (!['png', 'svg', 'gif'].includes(format)) throw new Error('不支持的图片输出格式');
  if (format !== 'png' && (request.protocol !== 'openai' || !supportsNativeImageOutput(request.model))) throw new Error('原生 SVG/GIF 输出需要 GPT Image 2.6 系列模型');
  if (format !== 'png' && (request.mode !== 'text-to-image' || request.images?.length)) {
    throw new Error(`原生 ${format.toUpperCase()} 仅支持文字生成，不支持参考图`);
  }
  if (format !== 'png' && request.gptImageMarkup) throw new Error('原生 SVG/GIF 模式暂不支持 Markup 标注，请切换回普通图片模式');
  if (format === 'gif') {
    for (const [key, fallback, min, max] of [['gifFrameCount', 9, 2, 16], ['gifFrameDurationMs', 200, 20, 2000]]) {
      const value = request[key] === undefined ? fallback : request[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${key === 'gifFrameCount' ? 'GIF 帧数' : 'GIF 每帧时长'}必须为 ${min}–${max} 之间的整数`);
      }
      request[key] = key === 'gifFrameDurationMs' ? Math.round(value / 10) * 10 : value;
    }
  } else {
    delete request.gifFrameCount;
    delete request.gifFrameDurationMs;
  }
  return format;
}

function extractChatImagePayload(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    const image = content.find(part => part.type === 'image_url');
    if (typeof image?.image_url?.url === 'string') return image.image_url.url;
  }
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => part.text || '').join('\n') : '';
  const inline = text.match(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/);
  if (inline) return inline[0];
  const link = text.match(/!?\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  if (link) return link[1];
  if (text.includes('sandbox:/')) throw new Error('上游仅返回内部 sandbox 文件链接，未返回可下载的图片数据');
  return undefined;
}

function buildImageOutputPrompt(request) {
  if (request.gptImageOutputFormat === 'gif') {
    return `${request.prompt}\n\n请生成并返回真正可播放的 GIF 动图文件，包含连续动画帧。不要返回静态图片、网格图、雪碧图或分镜拼图。`;
  }
  return request.prompt;
}

module.exports = { detectImageMime, decodeImagePayload, getImageExtension, isSvgText, validateImageOutput, buildImageOutputPrompt, extractChatImagePayload };
