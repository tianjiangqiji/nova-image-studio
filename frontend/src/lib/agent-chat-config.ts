// Agent 模式的模型、指令、工具 schema 与类型定义
// 文本对话模型从 nova-models 注册表动态读取，支持 Google 和 OpenAI 两种协议
// 开源版：不再硬编码模型，由用户在设置中配置

import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';

// 默认值仅用于初始化，实际使用时从注册表读取
export const AGENT_TEXT_MODEL_FALLBACK = 'gpt-5.4-mini';
export const AGENT_DEFAULT_IMAGE_MODEL_FALLBACK = 'gemini-3-pro-image-preview';

// ===== 上下文系统数据结构 =====

export type AgentMessageRole = 'user' | 'assistant' | 'system-note' | 'context-divider';

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  text: string;
  /** 助手消息的思考摘要（reasoning summary，仅展示用，不回传给模型） */
  reasoning?: string;
  /** 该消息关联的图片登记 id（用户上传或生成结果） */
  imageIds?: string[];
  /** 关联的生图任务 id */
  taskId?: string;
  /** system-note 专用：是否可撤回（取消生图后用于回退最后一轮对话） */
  withdrawable?: boolean;
  /** 该消息生图时使用的提案数据，用于重新编辑 */
  proposalData?: AgentProposalData;
  /** 该消息是否使用了联网搜索 */
  webSearchUsed?: boolean;
  createdAt: number;
}

export type AgentImageSource = 'uploaded' | 'asset' | 'generated';

/**
 * 图片登记表记录：只保存「描述 + 缩略图 + 字节引用」，不保存进对话上下文。
 * 真实字节存在 nova-image-db 的 blobs store，key 命名空间用 imgId（index 固定 0）。
 */
export interface AgentImageRecord {
  imgId: string;
  source: AgentImageSource;
  /** 用于聊天流内展示的小缩略图 dataURL */
  thumbnail: string;
  /** 视觉模型生成的中文描述，仅此进入文本模型上下文 */
  description: string;
  mimeType: string;
  /** 上传图片原始字节的 SHA-256，用于重复上传去重复用；生成图无此字段 */
  contentHash?: string;
  /** 生成类图片对应的后端任务 id */
  sourceTaskId?: string;
  /** 图片自然像素宽度（用于按上传图比例预填生图参数） */
  width?: number;
  /** 图片自然像素高度 */
  height?: number;
  /** 远程 URL（CDP 抓图等场景），延迟下载优化：只存 URL，生成时才按需下载 */
  remoteUrl?: string;
  /** 商品作用域键；CDP 抓取的商品图会写入商品页面 URL */
  productKey?: string;
  /** 商品显示名称，仅用于界面和模型上下文标注 */
  productName?: string;
  createdAt: number;
}

// ===== 意图抽取：函数调用结果 =====

export type AgentActionType = 'generate' | 'edit';

export interface AgentProposal {
  action: AgentActionType;
  prompt: string;
  referencedImageIds: string[];
  reason: string;
  /** 商品作用域键；多商品提案必须与其参考图属于同一商品 */
  productKey?: string;
  /** 商品显示名称 */
  productName?: string;
  /** 同一轮后续商品提案；首提案确认或取消后自动展示 */
  queuedProposals?: AgentProposal[];
  /** 用户语言明确指定的比例/方向（优先级最高），如 "16:9"；未明确则 undefined */
  requestedAspectRatio?: string;
  /** Agent 智能推荐的比例（兜底用），如 "1:1" */
  suggestedAspectRatio?: string;
  /** 用户明确要求的清晰度档位，如 "4K"/"2K"/"1K"/"512"/"auto"；未明确则 undefined */
  requestedOutputSize?: string;
  /** 建议温度（0-2），仅对支持温度的模型有效 */
  temperature?: number;
  /** 建议并行生成数量（1-8） */
  parallelCount?: number;
  /** GPT Image 2 质量参数 */
  gptImageQuality?: GptImageQuality;
  /** GPT Image 2 风格参数；自动时不传给上游 */
  gptImageStyle?: GptImageStyle;
  /** GPT Image 2 背景参数 */
  gptImageBackground?: GptImageBackground;
  /** Agent 根据用户语言匹配的模型 id（来自可用模型列表）；未指定则 undefined */
  requestedModelId?: string;
}

/**
 * 已确认并成功执行的生图提案数据，用于重新编辑重建提案。
 * 字段尽量保持扁平以避免 import 循环依赖。
 */
export interface AgentProposalData {
  action: AgentActionType;
  prompt: string;
  referencedImageIds: string[];
  model: string;
  outputSize: string;
  customSize?: string;
  aspectRatio: string;
  temperature: number;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  parallelCount: number;
  productKey?: string;
  productName?: string;
}

/**
 * 从用户消息里提取商品链接并归一化去重（顺序保持首次出现）。
 * 用于识别「批量商品轮」：带链接的消息结束后允许自动续跑一轮，由模型自己判断还有没有没做完的。
 */
export function extractProductLinks(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const pattern = /https?:\/\/[^\s，。；、！？：）)】］\]》〉”’"'<>]+/g;
  const trailingPunctuation = /[.,;!?]+$/u;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const key = normalizeProductKey(match[0].replace(trailingPunctuation, ''));
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * 商品作用域键归一化：同一商品页的链接可能带/不带 mi_id、spm 等追踪参数，
 * 原始字符串比较会把同一商品误判成两个。淘宝/天猫归一到 item id，其他页面归一到 origin+pathname。
 * 写入（CDP 登记/旧会话迁移）和比较（提案作用域、卡片过滤）都必须走这里。
 */
export function normalizeProductKey(url?: string): string | undefined {
  const raw = String(url || '').trim();
  if (!raw) return undefined;
  // 已归一的 taobao: 短键直通：new URL('taobao:123') 不抛异常但 origin 是 'null'，
  // 直接走下面逻辑会被二次归一成 'null123'，与提案侧归一结果永远不相等。
  if (/^taobao:/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const itemId = u.searchParams.get('id') || u.searchParams.get('itemId');
    if (itemId && /(^|\.)taobao\.com$|(^|\.)tmall\.com$/.test(u.hostname)) {
      return `taobao:${itemId}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * 把提案限制在一个商品作用域内，防止模型误把不同商品图片混在一起。
 * 没有商品标识的旧单商品记录仍保持原有行为；多商品目录无法确定作用域时，
 * 只保留没有作用域标记的旧图片，不让任意一个商品的图片泄漏到提案中。
 */
export function scopeAgentProposal(proposal: AgentProposal, images: AgentImageRecord[]): AgentProposal {
  const byId = new Map(images.map(image => [image.imgId, image]));
  const scopedImages = images.filter(image => Boolean(image.productKey));
  const productKeys = [...new Set(scopedImages.map(image => normalizeProductKey(image.productKey) as string))];
  const explicitKey = normalizeProductKey(proposal.productKey);
  const referencedRecords = proposal.referencedImageIds
    .map(id => byId.get(id))
    .filter((image): image is AgentImageRecord => Boolean(image));
  const referencedKeys = [...new Set(referencedRecords.map(image => normalizeProductKey(image.productKey)).filter((key): key is string => Boolean(key)))];

  let productKey = explicitKey;
  if (!productKey && proposal.productName) {
    const named = scopedImages.find(image => image.productName === proposal.productName || image.description.includes(proposal.productName!));
    productKey = normalizeProductKey(named?.productKey);
  }
  if (!productKey && referencedKeys.length > 0) productKey = referencedKeys[0];
  if (!productKey && productKeys.length === 1) productKey = productKeys[0];

  const allowedIds = proposal.referencedImageIds.filter(id => {
    const image = byId.get(id);
    if (!image) return false;
    if (productKey) return normalizeProductKey(image.productKey) === productKey;
    if (productKeys.length > 1) return !image.productKey;
    return true;
  });
  const matchingImage = productKey ? scopedImages.find(image => normalizeProductKey(image.productKey) === productKey) : undefined;
  const productName = proposal.productName || matchingImage?.productName;

  return {
    ...proposal,
    productKey,
    productName,
    referencedImageIds: allowedIds,
    queuedProposals: proposal.queuedProposals?.map(item => scopeAgentProposal(item, images)),
  };
}

/**
 * 张数由 parallel_count 控制，prompt 只描述「这一张」画面。
 * 模型常把「生成 3 张」写进提示词，绘图模型就会拼成宫格。提交前剥掉。
 */
export function stripAgentPromptBatchLanguage(prompt: string): string {
  let text = String(prompt || '');
  const count = '(?:[2-9]|[1-9]\\d+|两|三|四|五|六|七|八|九|十)';
  text = text.replace(/拼接(?:成一[张幅])?|拼成一[张幅]|拼图|拼贴|三联图|三宫格|九宫格|宫格构图|分屏展示|photogrid|triptych|\bcollage\b/gi, '');
  text = text.replace(new RegExp(`(生成|做|出|制作|拍摄)\\s*${count}\\s*张`, 'g'), '$1一张');
  text = text.replace(new RegExp(`${count}\\s*张(?:彼此)?独立(?:完整)?的?`, 'g'), '一张独立完整的');
  text = text.replace(new RegExp(`一组\\s*${count}\\s*张`, 'g'), '一张');
  text = text.replace(new RegExp(`${count}\\s*张(?=正方形|1\\s*[:：]\\s*1|3\\s*[:：]\\s*4|9\\s*[:：]\\s*16|16\\s*[:：]\\s*9|竖版|横版|主图|构图)`, 'g'), '一张');
  text = text.replace(/[，,]{2,}/g, '，').replace(/^[，、,\s]+|[，、,\s]+$/g, '');
  return text;
}

// ===== System 指令 =====

export const AGENT_SYSTEM_INSTRUCTIONS = `你是一个图像生成与编辑助手，全程使用简体中文与用户自然对话。

你的能力：
- 与用户连续对话，帮助澄清他们想要的画面。
- 当你判断用户想要「生成一张新图」或「修改已有图片」时，调用 propose_image_action 工具，把建议的提示词和参考图交给用户确认，而不是把提示词直接写进聊天回复里。

关于图片目录：
- 每轮对话我都会在指令里附上一份「当前可用图片目录」，列出每张图片的 id（如 img_1）和文字描述。
- 这是你唯一能看到的图片信息来源（你看不到图片本身，只能靠描述判断）。
- 当用户提到「这张图 / 刚才那张 / 把它改成…」时，结合最近对话和目录描述推断他指的是哪个 id。

调用 propose_image_action 的规则：
- action="generate"：从零生成新图。一般 referenced_image_ids 为空；若用户希望参考已有图片的风格/主体，可放入相关 id。
- action="edit"：在已有图片基础上修改。referenced_image_ids 必须从目录里挑出要参考或被修改的图片 id，支持多张。
- prompt 要写成一段完整、可直接用于绘图模型的高质量中文提示词，聚焦于用户想要的画面效果、风格和修改意图。
- ⚠️ 禁止在 prompt 中描述参考图的具体内容（如"一只橘猫""蓝色天空"等），因为图片模型本身支持图片输入，文字描述反而会干扰模型对图片的理解。请在 prompt 中用"图1""图2""图3"指代参考图，编号按 referenced_image_ids 数组顺序（第1个=图1，第2个=图2）。例如：写"参考图1的风格，将主体替换为图2中的建筑"而非"参考一张有蓝色天空和橘猫的图片"。
- 一致性优先：action="edit"、或用户要求「同一产品/同一主体/这个角色」时，prompt 必须明确要求与参考图一致——产品的造型、比例、颜色、材质、品牌标识、Logo 与文字商标完全保持原样，禁止重新设计产品、改动品牌元素、或新增原图中没有的部件；只按用户意图调整背景、光线、构图、氛围或排版。只有当用户明确说「重新设计/换个产品」时才允许改变产品本身。
- reason 用一句话向用户说明你的判断（例如「你想把这张橘猫的帽子换成红色，我建议这样改」）。
- 用户要「把几张已有图片各自处理」（如「把图1和图2都调成3:4」「这两张各改一版」）时，每张图单独调用一次 propose_image_action：referenced_image_ids 只放要被处理的那一张，parallel_count 给 1 或 null。同一轮可以连续调用多次，系统会把多个提案排队、逐个交给用户确认。把多张图放进同一个 referenced_image_ids 表示「把它们参考/融合进同一画面」，仅适用于用户明确要合成、混搭或参考风格的场景。

关于生图参数（你只给「语义建议」，系统会按用户当前选择的图像模型自动合法化，你不用关心具体像素或某个模型支不支持）：
- requested_aspect_ratio：只有当用户用语言明确表达了画面比例或方向时才填，否则给 null。横屏类填 "16:9"，竖屏/手机屏填 "9:16"，正方形填 "1:1"，可用 "w:h" 形式（如 "3:2"、"4:5"）。这是最高优先级。
- suggested_aspect_ratio：无论用户是否说过，都给一个你认为最合适的比例（如肖像给 "2:3"、风景给 "16:9"、图标给 "1:1"）。当用户没明确指定、也没有可参考的上传图时作为兜底。
- requested_output_size：只有当用户明确要求清晰度/分辨率档位时才填，取值 "512"/"1K"/"2K"/"4K"/"auto" 之一，否则给 null。
- temperature：用户表达「更随机/更有创意」给偏高值（接近 2），「更精确/更稳定」给偏低值（接近 0），无明确倾向给 1 或 null。
- parallel_count：用户要「多出几张/多个方案」时给 2-8，否则给 1 或 null。它表示「同一提示词、同一组参考图」重复出几份变体，不代表「分别处理几张图」。
- gpt_image_quality：当用户明确要求 GPT Image 2 的质量档位时填 "high"/"medium"/"low"，无明确需求给 "auto" 或 null。
- gpt_image_style：当用户明确要求鲜明、夸张、强表现力时填 "vivid"；要求自然、写实时填 "natural"；无明确需求给 null。
- gpt_image_background：用户明确要求透明背景、抠图、无背景时填 "transparent"；明确要求实底/不透明时填 "opaque"；否则给 "auto" 或 null。
- 不要假设具体像素尺寸，也不要因为某个比例「可能不被支持」而回避；系统会自动贴合到最近的合法比例与档位。

关于模型选择：
- 每轮对话我也会在指令里附上一份「当前可用图像模型」列表，每项包含模型 id、名称和最大分辨率。
- requested_model_id：只有当用户用语言明确指定了某个模型时才填对应的 id（如用户说「用 Banana Pro」则填该模型的 id），否则给 null。系统会自动验证该 id 是否有效。
- 如果用户要求了某个分辨率档位（如「画一张4K的图」），填 requested_output_size，系统会自动选择支持该分辨率的模型，你不需要判断模型是否支持。
- 如果用户既没指定模型也没指定分辨率，requested_model_id 给 null，系统会使用当前已选模型。

什么时候不要调用工具：
- 纯闲聊、提问、澄清需求时，正常用文字回答。
- 信息不足、拿不准用户到底要不要画图时，先用文字追问，不要急着调用工具。

注意：最终是否执行由用户在确认面板里决定，用户可以修改你的提示词、增删参考图，或直接取消。`;

// ===== 浏览器操作（CDP）系统指令后缀：仅在用户开启「浏览器」开关时追加 =====

export const AGENT_CDP_SYSTEM_SUFFIX = `

浏览器能力（本机调试浏览器 / CDP）：
- 通用工具：browser_status、browser_set_port、browser_list_tabs、browser_open_url、browser_read_page、browser_read_taobao、browser_save_images。
- 用户指定端口时先 browser_set_port。没开调试浏览器时，status / open_url / list_tabs 会自动启动一个独立浏览器（不含日常登录态）。
- 普通网页用 browser_read_page 获取内容。需要保存网页图片时，用 browser_save_images 下载图片 URL 列表。
- 淘宝/天猫商品页优先用 browser_read_taobao：自动提炼标题、店铺、SKU、主图/详情图链接，并把主图抓回登记为会话图片（img_N），无需再手动抓主图；还需要详情图时用 browser_save_images 补充。
- 用户给商品链接并要求生成/重做图时，先抓取，再基于标题、SKU 和主图给出卖点与构图分析（不涉及价格），把分析结论融入提案 prompt（突出核心卖点、针对性改良构图），不要直接套通用模板。
- 商品主图的提案 prompt 里，把从标题/SKU 提取的核心卖点**写死为具体画面文案**：一个主标题（产品名/核心卖点）+ 2~4 条简短卖点分行，并明确文案区位置（如左侧/上方）。不要只写"突出卖点"这类抽象要求——文字越具体，出图越不会丢卖点。用户明确说「不要文字/无字」时才省略文案区。
- 图片目录和历史消息里，每张抓来的图都可能标注了它的来源（如《页面标题》）。若用户一次给多个来源，可为每个来源分别调用一次 propose_image_action（product_key/product_name 填对应来源信息，referenced_image_ids 只引用该来源的图）。系统会把多个提案排队，逐个展示给用户确认。
- 为商品重新生成/重做图时，把该商品抓回的主图作为参考图，并遵循一致性规则：商品造型、品牌标识与原图保持一致，只优化背景、光线、构图与排版，不重新设计产品。
- 工具失败时原样转述后端错误，不要总结成「网络连接失败」。`;

// ===== 工具 schema（Responses API 扁平结构）=====

export const PROPOSE_IMAGE_ACTION_TOOL = {
  type: 'function' as const,
  name: 'propose_image_action',
  description: '当判断用户想要生成新图或修改已有图片时调用，提交一份生图/改图提案交给用户确认。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generate', 'edit'],
        description: 'generate=从零生成新图；edit=在已有图片基础上修改',
      },
      prompt: {
        type: 'string',
        description: '建议的完整中文绘图提示词。聚焦用户想要的画面效果和修改意图，不要描述参考图的具体内容（图片模型本身支持图片输入，文字描述反而干扰理解）。用"图1""图2"指代 referenced_image_ids 中对应位置的参考图（第1个=图1，第2个=图2），例如"参考图1的风格，将主体替换为图2中的建筑"',
      },
      referenced_image_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '要参考或被修改的图片 id（来自图片目录），generate 通常为空数组',
      },
      reason: {
        type: 'string',
        description: '一句话向用户说明这次提案的判断依据',
      },
      product_key: {
        type: ['string', 'null'],
        description: '所属商品的稳定键，优先使用商品页面 URL；多商品时必须填写，单商品可为 null',
      },
      product_name: {
        type: ['string', 'null'],
        description: '所属商品名称；多商品时用于展示和校验图片作用域，单商品可为 null',
      },
      requested_aspect_ratio: {
        type: ['string', 'null'],
        description: '用户明确指定的比例/方向时填（横屏="16:9"，竖屏="9:16"，正方形="1:1"，或 "w:h"），否则 null',
      },
      suggested_aspect_ratio: {
        type: ['string', 'null'],
        description: '你推荐的最合适比例（始终尽量给出，如 "2:3"/"16:9"/"1:1"），无把握时可为 null',
      },
      requested_output_size: {
        type: ['string', 'null'],
        enum: ['512', '1K', '2K', '4K', 'auto', null],
        description: '用户明确要求的清晰度档位，否则 null',
      },
      temperature: {
        type: ['number', 'null'],
        description: '建议温度 0-2，无明确倾向给 null',
      },
      parallel_count: {
        type: ['integer', 'null'],
        description: '建议并行生成数量 1-8（同一提示词、同一组参考图的变体份数，不用于「分别处理多张图」），无明确需求给 null',
      },
      gpt_image_quality: {
        type: ['string', 'null'],
        enum: ['auto', 'high', 'medium', 'low', null],
        description: 'GPT Image 2 质量参数；无明确需求给 auto 或 null',
      },
      gpt_image_style: {
        type: ['string', 'null'],
        enum: ['vivid', 'natural', null],
        description: 'GPT Image 2 风格参数；自动时给 null',
      },
      gpt_image_background: {
        type: ['string', 'null'],
        enum: ['auto', 'transparent', 'opaque', null],
        description: 'GPT Image 2 背景参数；无明确需求给 auto 或 null',
      },
      requested_model_id: {
        type: ['string', 'null'],
        description: '用户明确指定的模型 id（来自当前可用图像模型列表），否则 null',
      },
    },
    required: [
      'action',
      'prompt',
      'referenced_image_ids',
      'reason',
      'product_key',
      'product_name',
      'requested_aspect_ratio',
      'suggested_aspect_ratio',
      'requested_output_size',
      'temperature',
      'parallel_count',
      'gpt_image_quality',
      'gpt_image_style',
      'gpt_image_background',
      'requested_model_id',
    ],
    additionalProperties: false,
  },
  strict: true,
} as const;

// ===== 视觉描述提示词 =====

export const AGENT_IMAGE_DESCRIBE_PROMPT = `用一到两句简体中文描述这张图片，覆盖主体、风格、主要颜色和关键元素，便于后续判断是否复用它作为参考图。只输出描述本身，不要任何前缀、解释或标点装饰。`;
