// 构图规范（Layout Control）
// 用归一化包围盒描述物体位置 + 相对尺寸 + 空间关系，最终渲染成中文布局段落拼进提示词。
// 坐标约定：x/y 为左上角，w/h 为宽高，全部 ∈ [0,1]，原点在画面左上角。

export const LAYOUT_SPEC_VERSION = 1;

/** 单个包围盒的最小边长，避免拖出零面积框 */
export const MIN_LAYOUT_BOX_SIZE = 0.02;

/** 判定「重叠」的面积比阈值 */
const OVERLAP_RATIO_THRESHOLD = 0.15;

/** 横向分档边界 */
const COLUMN_EDGES = [0.34, 0.66] as const;

/** 纵向分档边界 */
const ROW_EDGES = [0.34, 0.66] as const;

/** 等效边长分档边界（sqrt(面积)） */
const SIZE_EDGES = [0.22, 0.45] as const;

/** 提示词里最多列出的空间关系条数（避免物体多时关系爆炸） */
const MAX_RELATION_LINES = 12;

export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutObject {
  id: string;
  /** 物体标签，例如「蓝色机器人」 */
  label: string;
  box: LayoutBox;
  /** 预留的层叠顺序，当前按数组顺序处理 */
  z?: number;
}

export type LayoutRelationType =
  | 'left-of'
  | 'right-of'
  | 'above'
  | 'below'
  | 'overlaps'
  | 'behind'
  | 'in-front-of';

export interface LayoutRelation {
  from: string;
  type: LayoutRelationType;
  to: string;
}

export interface LayoutSpec {
  version: number;
  /** 画布比例，例如 '1:1'、'16:9'；缺省视为 '1:1' */
  aspectRatio?: string;
  objects: LayoutObject[];
  relations: LayoutRelation[];
}

const RELATION_LABELS: Record<LayoutRelationType, string> = {
  'left-of': '左侧',
  'right-of': '右侧',
  above: '上方',
  below: '下方',
  overlaps: '部分重叠',
  behind: '后方',
  'in-front-of': '前方',
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function roundPercent(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100);
}

export function createEmptyLayoutSpec(aspectRatio?: string): LayoutSpec {
  return {
    version: LAYOUT_SPEC_VERSION,
    ...(aspectRatio ? { aspectRatio } : {}),
    objects: [],
    relations: [],
  };
}

/** 把 '16:9' 这类比例字符串转成宽高比数值；非法输入回落到 1 */
export function parseAspectRatioValue(ratio: string | undefined): number {
  if (!ratio) return 1;
  const match = String(ratio).match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return 1;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return width / height;
}

export function isLayoutSpecEmpty(spec: LayoutSpec | null | undefined): boolean {
  return !spec || spec.objects.length === 0;
}

/** 把包围盒收敛到 [0,1] 且保证最小边长；越界框会被平移回画面内 */
export function clampLayoutBox(box: LayoutBox): LayoutBox {
  const w = clamp(box.w, MIN_LAYOUT_BOX_SIZE, 1);
  const h = clamp(box.h, MIN_LAYOUT_BOX_SIZE, 1);
  const x = clamp(box.x, 0, 1 - w);
  const y = clamp(box.y, 0, 1 - h);
  return { x, y, w, h };
}

export function getBoxCenter(box: LayoutBox): { cx: number; cy: number } {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

/** 平移包围盒，越界时收敛回画面内 */
export function moveLayoutBox(box: LayoutBox, dx: number, dy: number): LayoutBox {
  return clampLayoutBox({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h });
}

/** 拖拽右下角缩放包围盒，保持左上角固定并保护最小尺寸 */
export function resizeLayoutBox(box: LayoutBox, dx: number, dy: number): LayoutBox {
  const w = clamp(box.w + dx, MIN_LAYOUT_BOX_SIZE, 1 - box.x);
  const h = clamp(box.h + dy, MIN_LAYOUT_BOX_SIZE, 1 - box.y);
  return { x: box.x, y: box.y, w, h };
}

/** 由拖拽起止两点构造包围盒（自动纠正反向拖拽） */
export function boxFromPoints(ax: number, ay: number, bx: number, by: number): LayoutBox {
  const x1 = clamp(Math.min(ax, bx), 0, 1);
  const y1 = clamp(Math.min(ay, by), 0, 1);
  const x2 = clamp(Math.max(ax, bx), 0, 1);
  const y2 = clamp(Math.max(ay, by), 0, 1);
  return clampLayoutBox({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
}

/** 生成不与现有物体重名的默认标签 */
export function nextLayoutLabel(objects: LayoutObject[]): string {
  const used = new Set(objects.map((item) => item.label));
  let index = 1;
  while (used.has(`物体${index}`)) index += 1;
  return `物体${index}`;
}

/** 生成未被占用的物体 id */
export function nextLayoutObjectId(objects: LayoutObject[]): string {
  const used = new Set(objects.map((item) => item.id));
  let index = 1;
  while (used.has(`obj_${index}`)) index += 1;
  return `obj_${index}`;
}

export function getBoxArea(box: LayoutBox): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

/** 两框交集面积 */
export function getBoxIntersectionArea(a: LayoutBox, b: LayoutBox): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/** 归一化规范：逐框收敛、丢弃空标签、重建关系并去重 */
export function normalizeLayoutSpec(spec: LayoutSpec): LayoutSpec {
  const seenLabels = new Set<string>();
  const objects = spec.objects
    .map((item, index) => ({
      id: item.id || `obj_${index + 1}`,
      label: String(item.label ?? '').trim(),
      box: clampLayoutBox(item.box),
      ...(typeof item.z === 'number' && Number.isFinite(item.z) ? { z: item.z } : {}),
    }))
    .filter((item) => {
      if (!item.label) return false;
      if (seenLabels.has(item.label)) return false;
      seenLabels.add(item.label);
      return true;
    });

  return {
    version: LAYOUT_SPEC_VERSION,
    ...(spec.aspectRatio ? { aspectRatio: spec.aspectRatio } : {}),
    objects,
    relations: deriveLayoutRelations(objects),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/%$/, ''));
    if (Number.isFinite(parsed)) {
      // 允许模型输出 8~30 这种百分比，统一除以 100
      return parsed > 1 ? parsed / 100 : parsed;
    }
  }
  return null;
}

function readBox(raw: unknown): LayoutBox | null {
  if (!isRecord(raw)) return null;
  const x = readFiniteNumber(raw.x);
  const y = readFiniteNumber(raw.y);
  const w = readFiniteNumber(raw.w ?? raw.width);
  const h = readFiniteNumber(raw.h ?? raw.height);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  return clampLayoutBox({ x, y, w, h });
}

/** 从模型输出里剥出 JSON 主体：兼容 ```json 围栏与前后解释文字 */
function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

/** 解析模型输出或素材库里的 JSON；结构不合法返回 null，不抛异常 */
export function parseLayoutSpec(raw: string): LayoutSpec | null {
  const text = extractJsonText(raw);
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const rawObjects = Array.isArray(parsed.objects) ? parsed.objects : null;
  if (!rawObjects) return null;

  const objects: LayoutObject[] = [];
  rawObjects.forEach((item, index) => {
    if (!isRecord(item)) return;
    const label = String(item.label ?? item.name ?? '').trim();
    const box = readBox(item.box ?? item);
    if (!label || !box) return;
    objects.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `obj_${index + 1}`,
      label,
      box,
    });
  });

  if (objects.length === 0) return null;

  const aspectRatio = typeof parsed.aspectRatio === 'string' && parsed.aspectRatio.trim()
    ? parsed.aspectRatio.trim()
    : undefined;

  return normalizeLayoutSpec({
    version: LAYOUT_SPEC_VERSION,
    ...(aspectRatio ? { aspectRatio } : {}),
    objects,
    relations: [],
  });
}

/** 稳定序列化：固定键序，方便存素材库与去重 */
export function stringifyLayoutSpec(spec: LayoutSpec): string {
  return JSON.stringify(
    {
      version: LAYOUT_SPEC_VERSION,
      ...(spec.aspectRatio ? { aspectRatio: spec.aspectRatio } : {}),
      objects: spec.objects.map((item) => ({
        id: item.id,
        label: item.label,
        box: {
          x: Number(item.box.x.toFixed(4)),
          y: Number(item.box.y.toFixed(4)),
          w: Number(item.box.w.toFixed(4)),
          h: Number(item.box.h.toFixed(4)),
        },
      })),
      relations: spec.relations.map((item) => ({ from: item.from, type: item.type, to: item.to })),
    },
    null,
    2,
  );
}

/** 构图线框配色：预览、框选画布与实时参考图同源，按索引循环 */
export const LAYOUT_BOX_COLORS = [
  '#3b82f6',
  '#f97316',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#ec4899',
] as const;

export function getLayoutBoxColor(index: number): string {
  return LAYOUT_BOX_COLORS[index % LAYOUT_BOX_COLORS.length];
}

/**
 * 按构图 JSON 实时渲染线框参考图：白底 + 彩色包围盒 + 标签条，
 * 与预览窗口的方块同款外观。生成结果直接作为图生图参考图输入，
 * 本身不落库（落库的只有构图 JSON 素材）。无 canvas 环境返回 null。
 */
export function renderLayoutReferenceImage(spec: LayoutSpec, maxSide = 1024): string | null {
  if (isLayoutSpecEmpty(spec)) return null;
  if (typeof document === 'undefined') return null;

  const ratio = parseAspectRatioValue(spec.aspectRatio);
  const width = ratio >= 1 ? maxSide : Math.round(maxSide * ratio);
  const height = ratio >= 1 ? Math.round(maxSide / ratio) : maxSide;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const fontSize = Math.max(12, Math.round(width * 0.022));
  const lineWidth = Math.max(2, Math.round(width * 0.004));

  spec.objects.forEach((object, index) => {
    const color = getLayoutBoxColor(index);
    const x = Math.round(object.box.x * width);
    const y = Math.round(object.box.y * height);
    const w = Math.round(object.box.w * width);
    const h = Math.round(object.box.h * height);

    ctx.fillStyle = `${color}1a`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(x, y, w, h);

    // 标签条：左上角色块 + 白字，与预览一致
    ctx.font = `${fontSize}px sans-serif`;
    const textWidth = Math.ceil(ctx.measureText(object.label).width);
    const barHeight = Math.round(fontSize * 1.5);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, textWidth + fontSize, barHeight);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(object.label, x + Math.round(fontSize / 2), y + barHeight / 2);
  });

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}


/** 由包围盒自动推导空间关系；每对物体只产出一条 */
export function deriveLayoutRelations(objects: LayoutObject[]): LayoutRelation[] {
  const relations: LayoutRelation[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    for (let j = i + 1; j < objects.length; j += 1) {
      const a = objects[i];
      const b = objects[j];
      const overlap = getBoxIntersectionArea(a.box, b.box);
      const minArea = Math.min(getBoxArea(a.box), getBoxArea(b.box));
      if (minArea > 0 && overlap / minArea >= OVERLAP_RATIO_THRESHOLD) {
        relations.push({ from: a.id, type: 'overlaps', to: b.id });
        continue;
      }
      const centerA = getBoxCenter(a.box);
      const centerB = getBoxCenter(b.box);
      const dx = centerA.cx - centerB.cx;
      const dy = centerA.cy - centerB.cy;
      if (Math.abs(dx) >= Math.abs(dy)) {
        relations.push({ from: a.id, type: dx >= 0 ? 'right-of' : 'left-of', to: b.id });
      } else {
        relations.push({ from: a.id, type: dy >= 0 ? 'below' : 'above', to: b.id });
      }
    }
  }
  return relations;
}

/** 中文方位短语，例如「左侧」「中央」「右侧偏上」 */
export function describeLayoutPosition(box: LayoutBox): string {
  const { cx, cy } = getBoxCenter(box);
  let horizontal = '中央';
  if (cx < COLUMN_EDGES[0]) horizontal = '左侧';
  else if (cx > COLUMN_EDGES[1]) horizontal = '右侧';

  let vertical = '';
  if (cy < ROW_EDGES[0]) vertical = '偏上';
  else if (cy > ROW_EDGES[1]) vertical = '偏下';

  return `${horizontal}${vertical}`;
}

/** 相对尺寸分档，按等效边长（sqrt 面积）判断，更贴近视觉感受 */
export function describeLayoutSize(box: LayoutBox): string {
  const edge = Math.sqrt(getBoxArea(box));
  if (edge < SIZE_EDGES[0]) return '较小';
  if (edge < SIZE_EDGES[1]) return '中等';
  return '较大';
}

function formatRange(start: number, length: number): string {
  return `${roundPercent(start)}%–${roundPercent(start + length)}%`;
}

function describeRelationLine(relation: LayoutRelation, labelById: Map<string, string>): string {
  const from = labelById.get(relation.from) ?? relation.from;
  const to = labelById.get(relation.to) ?? relation.to;
  return `${from} 位于 ${to} ${RELATION_LABELS[relation.type]}`;
}

/**
 * 渲染成中文布局段落。
 * 位置百分比足够精确，空间关系只作为辅助，因此限制条数避免提示词过长。
 */
export function buildLayoutPromptSection(spec: LayoutSpec): string {
  if (isLayoutSpecEmpty(spec)) return '';

  const ratio = spec.aspectRatio || '1:1';
  const lines: string[] = [
    `【构图规范 v${LAYOUT_SPEC_VERSION}】画布比例 ${ratio}。请严格按以下位置与相对尺寸构图：`,
  ];

  spec.objects.forEach((item, index) => {
    const position = describeLayoutPosition(item.box);
    const size = describeLayoutSize(item.box);
    const horizontal = formatRange(item.box.x, item.box.w);
    const vertical = formatRange(item.box.y, item.box.h);
    lines.push(
      `${index + 1}. ${item.label}（${position}，尺寸${size}）：水平 ${horizontal}，垂直 ${vertical}`,
    );
  });

  const labelById = new Map(spec.objects.map((item) => [item.id, item.label]));
  const relationLines = spec.relations
    .filter((relation) => labelById.has(relation.from) && labelById.has(relation.to))
    .slice(0, MAX_RELATION_LINES)
    .map((relation) => describeRelationLine(relation, labelById));

  if (relationLines.length > 0) {
    lines.push(`空间关系：${relationLines.join('；')}。`);
  }

  return lines.join('\n');
}

/** 主入口：把构图规范拼到用户提示词后面；无规范时原样返回 */
export function composePromptWithLayout(prompt: string, spec: LayoutSpec | null | undefined): string {
  const section = spec ? buildLayoutPromptSection(spec) : '';
  const base = String(prompt ?? '').trim();
  if (!section) return base;
  if (!base) return section;
  return `${base}\n\n${section}`;
}

/** 去掉提示词里已拼入的构图段落，便于再次编辑时不重复叠加 */
export function stripLayoutSection(prompt: string): string {
  const marker = `【构图规范 v${LAYOUT_SPEC_VERSION}】`;
  const index = String(prompt ?? '').indexOf(marker);
  if (index < 0) return String(prompt ?? '').trim();
  return prompt.slice(0, index).trim();
}
