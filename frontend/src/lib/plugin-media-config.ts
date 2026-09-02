/**
 * 插件参考素材的格式与体积约束。
 *
 * 这里是前端唯一的事实来源：`accept` 属性、拖拽过滤、格式说明弹层、上传前预校验
 * 全部从这里取，避免四处各写一份 MIME 列表然后慢慢漂移。
 * 默认值与后端 `getKindRules()` 保持一致；运行时用 `/api/nova/plugins` 返回的
 * `mediaLimits` 覆盖，这样改 env 不用改前端。
 */

import type { MediaKind } from '@/lib/plugin-schema';

export type { MediaKind };

export interface MediaKindConfig {
  kind: MediaKind;
  label: string;
  /** 可接受的 MIME 类型 */
  mimeTypes: string[];
  /** 可接受的扩展名（不含点），用于 accept 兜底与拖拽过滤 */
  extensions: string[];
  maxBytes: number;
  /** 上传前是否在浏览器里重编码压缩（只有图片压） */
  compress: boolean;
}

const MB = 1024 * 1024;

export const DEFAULT_MEDIA_CONFIG: Record<MediaKind, MediaKindConfig> = {
  images: {
    kind: 'images',
    label: '图片',
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
    maxBytes: 10 * MB,
    compress: true,
  },
  videos: {
    kind: 'videos',
    label: '视频',
    mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    extensions: ['mp4', 'webm', 'mov'],
    maxBytes: 50 * MB,
    compress: false,
  },
  audios: {
    kind: 'audios',
    label: '音频',
    mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'],
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
    maxBytes: 15 * MB,
    compress: false,
  },
};

/** 运行时生效的配置，可被后端 mediaLimits 覆盖。 */
let activeConfig: Record<MediaKind, MediaKindConfig> = DEFAULT_MEDIA_CONFIG;

export function getMediaConfig(kind: MediaKind): MediaKindConfig {
  return activeConfig[kind];
}

interface RawMediaLimit {
  maxBytes?: unknown;
  mimeTypes?: unknown;
  extensions?: unknown;
}

/**
 * 用后端返回的 mediaLimits 覆盖默认值。字段缺失或类型不对时保留默认，
 * 避免后端一处异常就让前端整个上传功能不可用。
 */
export function applyMediaLimits(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const next = { ...activeConfig };

  for (const kind of ['images', 'videos', 'audios'] as MediaKind[]) {
    const entry = (raw as Record<string, RawMediaLimit>)[kind];
    if (!entry || typeof entry !== 'object') continue;

    const base = DEFAULT_MEDIA_CONFIG[kind];
    const maxBytes = typeof entry.maxBytes === 'number' && entry.maxBytes > 0 ? entry.maxBytes : base.maxBytes;
    const mimeTypes = Array.isArray(entry.mimeTypes) && entry.mimeTypes.length > 0
      ? entry.mimeTypes.filter((m): m is string => typeof m === 'string')
      : base.mimeTypes;
    const extensions = Array.isArray(entry.extensions) && entry.extensions.length > 0
      ? entry.extensions.filter((e): e is string => typeof e === 'string')
      : base.extensions;

    next[kind] = { ...base, maxBytes, mimeTypes, extensions };
  }

  activeConfig = next;
}

export function __resetMediaConfigForTests(): void {
  activeConfig = DEFAULT_MEDIA_CONFIG;
}

/** `accept` 同时给 MIME 与后缀：部分系统对少见类型不报 MIME，只靠后缀才拦得住。 */
export function getAcceptAttribute(kind: MediaKind): string {
  const config = getMediaConfig(kind);
  return [...config.mimeTypes, ...config.extensions.map(ext => `.${ext}`)].join(',');
}

export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    const mb = bytes / MB;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/** 类型是否匹配该分区。MIME 为空（某些系统拖拽）时回退到看后缀。 */
export function isAcceptedFile(kind: MediaKind, file: File): boolean {
  const config = getMediaConfig(kind);
  const mime = (file.type || '').split(';')[0].trim().toLowerCase();
  if (mime) return config.mimeTypes.includes(mime);
  return config.extensions.includes(getExtension(file.name));
}

export interface FileSelectionResult {
  /** 类型与体积都通过、且在剩余名额内的文件 */
  accepted: File[];
  /** 类型不符 */
  rejectedType: File[];
  /** 超过体积上限（图片在压缩后仍超限才会进这里） */
  rejectedSize: File[];
  /** 因超出剩余名额被截断 */
  droppedOverflow: File[];
}

/**
 * 对一批选中/拖入的文件做分流。体积检查对需要压缩的类型跳过——图片要等压缩完
 * 才知道最终大小，在这里按原始体积拒绝会误杀本可压到合规的大图。
 */
export function selectFiles(kind: MediaKind, files: File[], remainingSlots: number): FileSelectionResult {
  const config = getMediaConfig(kind);
  const result: FileSelectionResult = {
    accepted: [],
    rejectedType: [],
    rejectedSize: [],
    droppedOverflow: [],
  };

  const typeOk: File[] = [];
  for (const file of files) {
    if (!isAcceptedFile(kind, file)) {
      result.rejectedType.push(file);
    } else if (!config.compress && file.size > config.maxBytes) {
      result.rejectedSize.push(file);
    } else {
      typeOk.push(file);
    }
  }

  const slots = Math.max(0, remainingSlots);
  result.accepted = typeOk.slice(0, slots);
  result.droppedOverflow = typeOk.slice(slots);
  return result;
}

/** 把分流结果里被拒绝的部分汇总成一句可直接 toast 的话；没有问题时返回 null。 */
export function describeRejections(kind: MediaKind, result: FileSelectionResult): string | null {
  const config = getMediaConfig(kind);
  const parts: string[] = [];
  if (result.rejectedType.length > 0) {
    parts.push(`${result.rejectedType.length} 个格式不支持（仅支持 ${config.extensions.join(' / ')}）`);
  }
  if (result.rejectedSize.length > 0) {
    parts.push(`${result.rejectedSize.length} 个超过 ${formatBytes(config.maxBytes)}`);
  }
  if (result.droppedOverflow.length > 0) {
    parts.push(`${result.droppedOverflow.length} 个超出剩余名额`);
  }
  return parts.length > 0 ? `已忽略 ${parts.join('，')}` : null;
}
