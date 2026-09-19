// 阿里云百炼图片生成协议适配（DashScope multimodal-generation）
// 官方文档：
//   - Token Plan 套餐接入：https://platform.qianwenai.com/docs/token-plan/best-practices/multimodal-generation
//   - DashScope 付费版：https://help.aliyun.com/zh/model-studio/qwen-image-api
// 与 openai 协议的差异：
//   1. 端点固定为 /api/v1/services/aigc/multimodal-generation/generation
//   2. 请求体是 DashScope 格式：{ model, input: { messages }, parameters: { size } }
//   3. 响应在 output.choices[0].message.content[0].image 里（URL 字符串）
//   4. 图生图在 messages 里混入 image 类型的 content（data URL）
//   5. 支持端点：
//      - Token Plan 套餐：https://token-plan.cn-beijing.maas.aliyuncs.com（套餐 Key sk-sp-）
//      - 业务空间专属：https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com（付费 Key sk-）
//      - 通用端点：https://dashscope.aliyuncs.com（付费 Key sk-）

// 默认端点：Token Plan 套餐端点（适配官方最佳实践文档）
const DEFAULT_DASHSCOPE_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com';

function buildDashScopeImageUrl(baseUrl) {
  let trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  // 用户可能把文档里的完整端点（含 /compatible-mode/v1、/api/v1 等路径）粘进 baseUrl；
  // 统一裁到 host 根再拼固定图片生成路径，否则拼出 .../compatible-mode/api/v1/... 直接 404。
  // 多段后缀会叠加（如 /compatible-mode/api/v1），每个 replace 只锚定结尾匹配一次，
  // 所以循环剥离到不再变化为止；半截形态（/compatible-mode/api、/api）也一并容忍，
  // 防止上游先剥过一层（如 normalizeProtocolBaseUrl 的 /v1 剥离）后这里剥不干净。
  for (;;) {
    const next = trimmed
      .replace(/\/compatible-mode(\/v\d+)?$/i, '')
      .replace(/\/api\/v\d+$/i, '')
      .replace(/\/v\d+$/i, '')
      .replace(/\/compatible-mode$/i, '')
      .replace(/\/api$/i, '');
    if (next === trimmed) break;
    trimmed = next;
  }
  const base = trimmed || DEFAULT_DASHSCOPE_BASE_URL;
  return `${base}/api/v1/services/aigc/multimodal-generation/generation`;
}

// DashScope 请求体：messages 数组，content 可包含 text 和 image（data URL）
// 不同模型的参考图数量限制（官方文档）：
//   阿里云系列：
//     - qwen-image-3.0-pro: 最多 3 张
//     - wan2.7-image / wan2.7-image-pro: 最多 9 张
//     - happyhorse-1.1-r2v: 最多 9 张
//     - happyhorse-1.1-i2v: 1 张（首帧）
//     - happyhorse-1.1-t2v: 0 张（纯文生视频）
//   火山方舟豆包系列（doubao/seedream）：
//     - seedream-5.0-pro: 最多 10 张
//     - seedream-5.0-lite / 4.5 / 4.0: 最多 14 张 ✓ 最宽松
function buildDashScopeImagePayload(request, size) {
  const content = [];
  const hasImages = Array.isArray(request.images) && request.images.length > 0;
  if (hasImages) {
    // 根据模型判断参考图数量限制
    const modelId = String(request.model || '').toLowerCase();
    let maxImages = 3; // 默认 Qwen Image 限制
    let modelName = 'Qwen Image 3.0';

    if (modelId.includes('wan')) {
      maxImages = 9;
      modelName = 'Wan 2.7';
    } else if (modelId.includes('happyhorse')) {
      if (modelId.includes('r2v')) {
        maxImages = 9;
        modelName = 'HappyHorse R2V';
      } else if (modelId.includes('i2v')) {
        maxImages = 1;
        modelName = 'HappyHorse I2V';
      } else if (modelId.includes('t2v')) {
        maxImages = 0;
        modelName = 'HappyHorse T2V';
      }
    }

    if (request.images.length > maxImages) {
      const suggestions = [];
      if (maxImages < 9) {
        suggestions.push(`减少到 ${maxImages} 张`);
        suggestions.push('或切换到 Wan 2.7（支持 9 张）');
      }
      if (maxImages < 14) {
        suggestions.push('或切换到豆包 Seedream 5.0 Lite（支持 14 张）');
      }
      if (maxImages === 0) {
        suggestions.push('此模型不支持参考图（纯文生视频）');
      }

      throw new Error(
        `${modelName} 最多支持 ${maxImages} 张参考图，` +
        `当前提供了 ${request.images.length} 张。` +
        `建议：${suggestions.join('；')}`
      );
    }

    // I2I：先全部 image，最后 text
    for (const img of request.images) {
      content.push({ image: `data:${img.mimeType || 'image/png'};base64,${img.data}` });
    }
  }
  content.push({ text: request.prompt });
  const payload = {
    model: request.model,
    input: {
      messages: [{ role: 'user', content }],
    },
  };
  // DashScope size 用星号分隔，如 1024*1024；WxH / WXH 都转成 W*H
  const parameters = { watermark: false };
  if (size) {
    parameters.size = String(size).replace(/[xX]/g, '*');
  }
  if (Object.keys(parameters).length > 0) {
    payload.parameters = parameters;
  }
  return payload;
}

// 从 DashScope 响应提取图片 URL（output.choices[0].message.content[0].image）
function extractDashScopeImageUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const choices = data.output?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = choices[0]?.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const imageUrl = content.find(item => typeof item?.image === 'string')?.image;
  return imageUrl || null;
}

module.exports = {
  DEFAULT_DASHSCOPE_BASE_URL,
  buildDashScopeImageUrl,
  buildDashScopeImagePayload,
  extractDashScopeImageUrl,
};
