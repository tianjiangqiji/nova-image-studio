'use strict';

/**
 * 智能 UI Schema 合成器（Schema Synthesizer）
 *
 * 核心目标：
 * 当插件开发者采用「1 个描述文件 (manifest.json) + 1 个 JS 驱动 (index.js)」的极简模式时，
 * 开发者无需手写 7KB 晦涩复杂的 ui.schema.json。
 * 本模块负责根据 manifest.json 中声明的元数据与特性（features），
 * 自动推导出符合前端与校验器规范的完整 PluginUiSchema。
 */

const DEFAULT_ASPECT_RATIOS = [
  { value: '16:9', label: '16:9 横屏', description: '适合电脑、电视与横版视频' },
  { value: '9:16', label: '9:16 竖屏', description: '适合抖音、快手与手机全屏' },
  { value: '1:1', label: '1:1 方形', description: '适合社交头像与方形画幅' },
  { value: '4:3', label: '4:3 标准', description: '经典画幅比例' },
  { value: '3:4', label: '3:4 竖版', description: '电商展示与海报比例' },
  { value: '21:9', label: '21:9 宽画幅', description: '电影宽银幕质感' },
];

const DEFAULT_DURATIONS = [
  { value: 5, label: '5 秒' },
  { value: 10, label: '10 秒' },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 根据 manifest.json 自动合成标准的 uiSchema
 * @param {object} manifest - 插件的 manifest.json 对象
 * @returns {object} 符合 PluginUiSchema 规范的完整对象
 */
function synthesizeUiSchema(manifest) {
  if (!isPlainObject(manifest)) {
    throw new Error('manifest 必须是有效对象');
  }

  const models = Array.isArray(manifest.models) ? manifest.models : [];
  if (models.length === 0) {
    throw new Error('manifest.models 不能为空');
  }

  const features = isPlainObject(manifest.features) ? manifest.features : {};

  // 1. 构建 ModelSelector（模型选择矩阵）
  const facetKey = 'targetModel';
  const facets = [
    {
      key: facetKey,
      label: '模型',
      icon: 'sparkles',
      control: 'list',
      hideWhenSingle: models.length <= 1,
    },
  ];

  const facetOptions = {
    [facetKey]: models.map(m => ({
      value: m.id,
      label: m.name || m.id,
      description: m.description || undefined,
    })),
  };

  const variants = models.map(m => ({
    model: m.id,
    [facetKey]: m.id,
  }));

  const modelSelector = {
    label: '模型选择',
    familyLabel: manifest.name || manifest.id,
    familyDescription: manifest.description || '',
    facets,
    facetOptions,
    variants,
  };

  // 2. 构建表单字段 (Fields)
  const fields = [];
  const toolbar = ['$model'];
  const body = [];

  // 2.1 生成模式 (Mode) 字段（可选）
  if (Array.isArray(features.modes) && features.modes.length > 0) {
    const modeOptions = features.modes.map(opt => {
      if (typeof opt === 'string') return { value: opt, label: opt };
      return {
        value: opt.value || opt.key,
        label: opt.label || opt.value || opt.key,
        description: opt.description || undefined,
      };
    });
    fields.push({
      key: 'mode',
      type: 'select',
      label: '生成模式',
      icon: 'layers',
      default: modeOptions[0].value,
      hideWhenSingle: modeOptions.length <= 1,
      options: modeOptions,
    });
    toolbar.push('mode');
  }

  // 2.2 画面比例 (AspectRatio) 字段
  const ratioList = Array.isArray(features.aspectRatios) && features.aspectRatios.length > 0
    ? features.aspectRatios.map(r => {
      if (typeof r === 'string') {
        const found = DEFAULT_ASPECT_RATIOS.find(item => item.value === r);
        return found || { value: r, label: r };
      }
      return r;
    })
    : DEFAULT_ASPECT_RATIOS;

  fields.push({
    key: 'aspectRatio',
    type: 'select',
    label: '画面比例',
    icon: 'aspect-ratio',
    default: ratioList[0]?.value || '16:9',
    hideWhenSingle: ratioList.length <= 1,
    options: ratioList,
  });
  toolbar.push('aspectRatio');

  // 2.3 视频时长 (Seconds) 字段
  const durationList = Array.isArray(features.durations) && features.durations.length > 0
    ? features.durations.map(d => {
      const val = Number(typeof d === 'object' ? d.value : d);
      return {
        value: val,
        label: typeof d === 'object' && d.label ? d.label : `${val} 秒`,
      };
    })
    : DEFAULT_DURATIONS;

  fields.push({
    key: 'seconds',
    type: 'select',
    label: '视频时长',
    icon: 'clock',
    default: durationList[0]?.value || 5,
    hideWhenSingle: durationList.length <= 1,
    options: durationList,
  });
  toolbar.push('seconds');

  // 2.4 参考素材字段 (Media Slots)
  const mediaSpec = isPlainObject(manifest.media) ? manifest.media : {};
  if (mediaSpec.images && Number(mediaSpec.images.maxCount) > 0) {
    fields.push({
      key: 'images',
      type: 'media',
      kind: 'images',
      label: mediaSpec.images.label || '参考图片',
      hint: mediaSpec.images.hint || '可拖入垫图辅助构图或人物设定',
      style: 'chip',
      maxCount: Number(mediaSpec.images.maxCount),
    });
    body.push('images');
  }

  if (mediaSpec.videos && Number(mediaSpec.videos.maxCount) > 0) {
    fields.push({
      key: 'reference_videos',
      type: 'media',
      kind: 'videos',
      label: mediaSpec.videos.label || '参考视频',
      hint: mediaSpec.videos.hint || '提供参考运镜或动态的视频素材',
      style: 'chip',
      maxCount: Number(mediaSpec.videos.maxCount),
    });
    body.push('reference_videos');
  }

  if (mediaSpec.audios && Number(mediaSpec.audios.maxCount) > 0) {
    fields.push({
      key: 'reference_audios',
      type: 'media',
      kind: 'audios',
      label: mediaSpec.audios.label || '参考音频',
      hint: mediaSpec.audios.hint || '用于对齐卡点节奏的音频',
      style: 'chip',
      maxCount: Number(mediaSpec.audios.maxCount),
    });
    body.push('reference_audios');
  }

  // 2.5 自定义扩展控件 (Custom Controls，用于运镜、参数调节等新模式)
  if (Array.isArray(features.customControls)) {
    for (const ctrl of features.customControls) {
      if (isPlainObject(ctrl) && ctrl.key && ctrl.type) {
        fields.push(ctrl);
        if (ctrl.type === 'media') {
          body.push(ctrl.key);
        } else {
          toolbar.push(ctrl.key);
        }
      }
    }
  }

  // 2.6 提示词 (Prompt) 字段（核心大文本框）
  fields.push({
    key: 'prompt',
    type: 'textarea',
    label: '画面描述',
    placeholder: features.promptPlaceholder || '详细描述画面主体、动态过程、光影氛围与运镜视角...',
    required: true,
    requiredHint: '请填写视频画面描述',
    maxLength: features.maxPromptLength || 2000,
    rows: 4,
  });
  body.push('prompt');

  return {
    apiVersion: 1,
    priceQuantityField: 'seconds',
    layout: {
      toolbar,
      body,
    },
    modelSelector,
    fields,
  };
}

module.exports = {
  synthesizeUiSchema,
};
