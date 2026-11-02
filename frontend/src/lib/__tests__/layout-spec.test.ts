import { describe, expect, it } from 'vitest';

import {
  boxFromPoints,
  buildLayoutPromptSection,
  clampLayoutBox,
  composePromptWithLayout,
  createEmptyLayoutSpec,
  deriveLayoutRelations,
  describeLayoutPosition,
  describeLayoutSize,
  getBoxIntersectionArea,
  getLayoutBoxColor,
  isLayoutSpecEmpty,
  LAYOUT_BOX_COLORS,
  LAYOUT_SPEC_VERSION,
  MIN_LAYOUT_BOX_SIZE,
  moveLayoutBox,
  nextLayoutLabel,
  nextLayoutObjectId,
  normalizeLayoutSpec,
  parseAspectRatioValue,
  parseLayoutSpec,
  renderLayoutReferenceImage,
  resizeLayoutBox,
  stringifyLayoutSpec,
  stripLayoutSection,
  type LayoutObject,
  type LayoutSpec,
} from '@/lib/layout-spec';
import { LAYOUT_TEMPLATES, getLayoutTemplate } from '@/lib/layout-spec-templates';

function obj(id: string, label: string, x: number, y: number, w: number, h: number): LayoutObject {
  return { id, label, box: { x, y, w, h } };
}

function specOf(objects: LayoutObject[], aspectRatio = '1:1'): LayoutSpec {
  return { version: LAYOUT_SPEC_VERSION, aspectRatio, objects, relations: deriveLayoutRelations(objects) };
}

describe('clampLayoutBox', () => {
  it('收敛越界坐标到画面内', () => {
    expect(clampLayoutBox({ x: -0.5, y: -0.2, w: 0.4, h: 0.3 })).toEqual({ x: 0, y: 0, w: 0.4, h: 0.3 });
    expect(clampLayoutBox({ x: 0.9, y: 0.95, w: 0.4, h: 0.3 })).toEqual({ x: 0.6, y: 0.7, w: 0.4, h: 0.3 });
  });

  it('保证最小边长', () => {
    const box = clampLayoutBox({ x: 0.5, y: 0.5, w: 0, h: -1 });
    expect(box.w).toBe(MIN_LAYOUT_BOX_SIZE);
    expect(box.h).toBe(MIN_LAYOUT_BOX_SIZE);
  });

  it('超过 1 的宽高被截断为整幅', () => {
    expect(clampLayoutBox({ x: 0, y: 0, w: 2, h: 3 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('NaN 输入回落到最小值而不是产生 NaN', () => {
    const box = clampLayoutBox({ x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN });
    expect(box).toEqual({ x: 0, y: 0, w: MIN_LAYOUT_BOX_SIZE, h: MIN_LAYOUT_BOX_SIZE });
  });
});

describe('getBoxIntersectionArea', () => {
  it('相交时返回交集面积', () => {
    expect(getBoxIntersectionArea({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })).toBeCloseTo(0.0625, 6);
  });

  it('不相交返回 0', () => {
    expect(getBoxIntersectionArea({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toBe(0);
  });
});

describe('normalizeLayoutSpec', () => {
  it('丢弃空标签与重复标签', () => {
    const normalized = normalizeLayoutSpec(
      specOf([
        obj('a', '商品', 0.1, 0.1, 0.2, 0.2),
        obj('b', '   ', 0.3, 0.3, 0.2, 0.2),
        obj('c', '商品', 0.5, 0.5, 0.2, 0.2),
      ]),
    );
    expect(normalized.objects).toHaveLength(1);
    expect(normalized.objects[0].label).toBe('商品');
  });

  it('缺少 id 时补 obj_N', () => {
    const normalized = normalizeLayoutSpec(specOf([{ id: '', label: '主体', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }]));
    expect(normalized.objects[0].id).toBe('obj_1');
  });

  it('重新推导关系而不是沿用传入值', () => {
    const input: LayoutSpec = {
      version: LAYOUT_SPEC_VERSION,
      objects: [obj('a', '左', 0.05, 0.1, 0.2, 0.2), obj('b', '右', 0.7, 0.1, 0.2, 0.2)],
      relations: [{ from: 'b', type: 'above', to: 'a' }],
    };
    const normalized = normalizeLayoutSpec(input);
    expect(normalized.relations).toEqual([{ from: 'a', type: 'left-of', to: 'b' }]);
  });
});

describe('parseLayoutSpec', () => {
  const valid = JSON.stringify({
    version: 1,
    aspectRatio: '16:9',
    objects: [
      { id: 'obj_1', label: '蓝色机器人', box: { x: 0.08, y: 0.12, w: 0.22, h: 0.55 } },
      { id: 'obj_2', label: '橙色方块', box: { x: 0.4, y: 0.55, w: 0.15, h: 0.17 } },
    ],
  });

  it('解析合法 JSON', () => {
    const parsed = parseLayoutSpec(valid);
    expect(parsed?.aspectRatio).toBe('16:9');
    expect(parsed?.objects).toHaveLength(2);
    expect(parsed?.objects[0].label).toBe('蓝色机器人');
  });

  it('剥离 ```json 代码围栏', () => {
    const parsed = parseLayoutSpec('```json\n' + valid + '\n```');
    expect(parsed?.objects).toHaveLength(2);
  });

  it('剥离前后解释文字', () => {
    const parsed = parseLayoutSpec(`好的，以下是构图规范：\n${valid}\n希望有帮助！`);
    expect(parsed?.objects).toHaveLength(2);
  });

  it('接受 width/height 别名与百分比字符串', () => {
    const parsed = parseLayoutSpec(
      JSON.stringify({ objects: [{ label: '主体', x: '8%', y: '12%', width: '22%', height: '55%' }] }),
    );
    expect(parsed?.objects[0].box).toEqual({ x: 0.08, y: 0.12, w: 0.22, h: 0.55 });
  });

  it('宽高为 0 的物体被丢弃', () => {
    expect(parseLayoutSpec(JSON.stringify({ objects: [{ label: '主体', x: 0.1, y: 0.1, w: 0, h: 0.2 }] }))).toBeNull();
  });

  it('非 JSON 返回 null', () => {
    expect(parseLayoutSpec('这不是 JSON')).toBeNull();
    expect(parseLayoutSpec('')).toBeNull();
  });

  it('缺少 objects 返回 null', () => {
    expect(parseLayoutSpec(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it('objects 全不合法返回 null', () => {
    expect(parseLayoutSpec(JSON.stringify({ objects: [{ label: '', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] }))).toBeNull();
  });
});

describe('stringifyLayoutSpec 往返', () => {
  it('序列化后可被解析回来', () => {
    const original = specOf([obj('a', '主体', 0.123456, 0.2, 0.3, 0.4), obj('b', '背景', 0, 0, 1, 1)]);
    const parsed = parseLayoutSpec(stringifyLayoutSpec(original));
    expect(parsed).not.toBeNull();
    expect(parsed?.objects.map((item) => item.label)).toEqual(['主体', '背景']);
    expect(parsed?.objects[0].box.x).toBeCloseTo(0.1235, 4);
  });

  it('保留 aspectRatio', () => {
    const parsed = parseLayoutSpec(stringifyLayoutSpec(specOf([obj('a', '主体', 0.1, 0.1, 0.2, 0.2)], '3:4')));
    expect(parsed?.aspectRatio).toBe('3:4');
  });
});

describe('deriveLayoutRelations', () => {
  it('水平相邻判 left-of', () => {
    const relations = deriveLayoutRelations([obj('a', '左', 0.05, 0.2, 0.2, 0.2), obj('b', '右', 0.7, 0.2, 0.2, 0.2)]);
    expect(relations).toEqual([{ from: 'a', type: 'left-of', to: 'b' }]);
  });

  it('垂直相邻判 above', () => {
    const relations = deriveLayoutRelations([obj('a', '上', 0.2, 0.05, 0.2, 0.2), obj('b', '下', 0.2, 0.7, 0.2, 0.2)]);
    expect(relations).toEqual([{ from: 'a', type: 'above', to: 'b' }]);
  });

  it('显著重叠判 overlaps', () => {
    const relations = deriveLayoutRelations([obj('a', '甲', 0.2, 0.2, 0.4, 0.4), obj('b', '乙', 0.3, 0.3, 0.4, 0.4)]);
    expect(relations).toEqual([{ from: 'a', type: 'overlaps', to: 'b' }]);
  });

  it('N 个物体只产生 C(N,2) 条关系', () => {
    const objects = [obj('a', '甲', 0.05, 0.1, 0.15, 0.15), obj('b', '乙', 0.4, 0.1, 0.15, 0.15), obj('c', '丙', 0.75, 0.1, 0.15, 0.15)];
    expect(deriveLayoutRelations(objects)).toHaveLength(3);
  });

  it('单物体无关系', () => {
    expect(deriveLayoutRelations([obj('a', '甲', 0.1, 0.1, 0.2, 0.2)])).toEqual([]);
  });
});

describe('describeLayoutPosition', () => {
  it('左中右三档', () => {
    expect(describeLayoutPosition({ x: 0.02, y: 0.4, w: 0.2, h: 0.2 })).toBe('左侧');
    expect(describeLayoutPosition({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe('中央');
    expect(describeLayoutPosition({ x: 0.78, y: 0.4, w: 0.2, h: 0.2 })).toBe('右侧');
  });

  it('上下叠加偏上 / 偏下', () => {
    expect(describeLayoutPosition({ x: 0.4, y: 0.02, w: 0.2, h: 0.2 })).toBe('中央偏上');
    expect(describeLayoutPosition({ x: 0.4, y: 0.78, w: 0.2, h: 0.2 })).toBe('中央偏下');
  });

  it('边界值 0 与 1 落在极值档', () => {
    expect(describeLayoutPosition({ x: 0, y: 0, w: MIN_LAYOUT_BOX_SIZE, h: MIN_LAYOUT_BOX_SIZE })).toBe('左侧偏上');
    expect(describeLayoutPosition({ x: 0.98, y: 0.98, w: MIN_LAYOUT_BOX_SIZE, h: MIN_LAYOUT_BOX_SIZE })).toBe('右侧偏下');
  });
});

describe('describeLayoutSize', () => {
  it('按等效边长分三档', () => {
    expect(describeLayoutSize({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 })).toBe('较小');
    expect(describeLayoutSize({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 })).toBe('中等');
    expect(describeLayoutSize({ x: 0, y: 0, w: 0.9, h: 0.9 })).toBe('较大');
  });
});

describe('buildLayoutPromptSection', () => {
  it('空规范返回空串', () => {
    expect(buildLayoutPromptSection(createEmptyLayoutSpec())).toBe('');
  });

  it('渲染物体与空间关系', () => {
    const section = buildLayoutPromptSection(
      specOf([
        obj('a', '蓝色机器人', 0.08, 0.12, 0.22, 0.55),
        obj('b', '橙色方块', 0.4, 0.55, 0.15, 0.17),
      ]),
    );
    expect(section).toContain('【构图规范 v1】画布比例 1:1');
    expect(section).toContain('1. 蓝色机器人（左侧，尺寸中等）：水平 8%–30%，垂直 12%–67%');
    expect(section).toContain('2. 橙色方块（中央，尺寸较小）：水平 40%–55%，垂直 55%–72%');
    expect(section).toContain('空间关系：蓝色机器人 位于 橙色方块 左侧。');
  });

  it('缺省比例按 1:1 输出', () => {
    const section = buildLayoutPromptSection({ version: 1, objects: [obj('a', '主体', 0.1, 0.1, 0.2, 0.2)], relations: [] });
    expect(section).toContain('画布比例 1:1');
  });

  it('单物体不输出空间关系行', () => {
    expect(buildLayoutPromptSection(specOf([obj('a', '主体', 0.1, 0.1, 0.2, 0.2)]))).not.toContain('空间关系');
  });

  it('关系条数受上限保护', () => {
    const objects = Array.from({ length: 8 }, (_, index) => obj(`o${index}`, `物体${index}`, 0.01 + index * 0.12, 0.1, 0.05, 0.05));
    const section = buildLayoutPromptSection(specOf(objects));
    const relationLine = section.split('\n').find((line) => line.startsWith('空间关系')) ?? '';
    expect(relationLine.split('；').length).toBeLessThanOrEqual(12);
  });
});

describe('getLayoutBoxColor', () => {
  it('按索引循环取色，与预览/框选画布/参考图同源', () => {
    expect(getLayoutBoxColor(0)).toBe(LAYOUT_BOX_COLORS[0]);
    expect(getLayoutBoxColor(LAYOUT_BOX_COLORS.length)).toBe(LAYOUT_BOX_COLORS[0]);
    expect(getLayoutBoxColor(LAYOUT_BOX_COLORS.length + 2)).toBe(LAYOUT_BOX_COLORS[2]);
  });
});

describe('renderLayoutReferenceImage', () => {
  it('空规范返回 null（无可渲染的参考图）', () => {
    expect(renderLayoutReferenceImage(createEmptyLayoutSpec())).toBeNull();
  });

  it('无法取得 2D 上下文时返回 null 而不抛异常', () => {
    // jsdom 未实现 canvas 后端：getContext('2d') 返回 null，走兜底分支
    const result = renderLayoutReferenceImage(specOf([obj('a', '主体', 0.1, 0.1, 0.2, 0.2)]));
    expect(result === null || result.startsWith('data:image/png;base64,')).toBe(true);
  });
});


describe('composePromptWithLayout', () => {
  const layout = specOf([obj('a', '主体', 0.1, 0.1, 0.2, 0.2)]);

  it('无规范时原样返回提示词', () => {
    expect(composePromptWithLayout('一只猫', null)).toBe('一只猫');
    expect(composePromptWithLayout('一只猫', createEmptyLayoutSpec())).toBe('一只猫');
  });

  it('空提示词只返回布局段落', () => {
    const composed = composePromptWithLayout('', layout);
    expect(composed.startsWith('【构图规范 v1】')).toBe(true);
  });

  it('两者都有时用空行连接', () => {
    const composed = composePromptWithLayout('一只猫', layout);
    expect(composed.startsWith('一只猫\n\n【构图规范 v1】')).toBe(true);
  });

  it('首尾空白被清理', () => {
    expect(composePromptWithLayout('  一只猫  ', layout).startsWith('一只猫\n\n')).toBe(true);
  });
});

describe('stripLayoutSection', () => {
  it('剥离已拼入的构图段落', () => {
    const composed = composePromptWithLayout('一只猫', specOf([obj('a', '主体', 0.1, 0.1, 0.2, 0.2)]));
    expect(stripLayoutSection(composed)).toBe('一只猫');
  });

  it('无构图段落时原样返回并 trim', () => {
    expect(stripLayoutSection('  一只猫  ')).toBe('一只猫');
  });
});

describe('isLayoutSpecEmpty', () => {
  it('null 与无物体都算空', () => {
    expect(isLayoutSpecEmpty(null)).toBe(true);
    expect(isLayoutSpecEmpty(createEmptyLayoutSpec())).toBe(true);
    expect(isLayoutSpecEmpty(specOf([obj('a', '主体', 0.1, 0.1, 0.2, 0.2)]))).toBe(false);
  });
});

describe('parseAspectRatioValue', () => {
  it('解析常见比例', () => {
    expect(parseAspectRatioValue('16:9')).toBeCloseTo(16 / 9, 6);
    expect(parseAspectRatioValue('1:1')).toBe(1);
    expect(parseAspectRatioValue('3:4')).toBe(0.75);
  });

  it('缺省与非法输入回落到 1', () => {
    expect(parseAspectRatioValue(undefined)).toBe(1);
    expect(parseAspectRatioValue('')).toBe(1);
    expect(parseAspectRatioValue('auto')).toBe(1);
    expect(parseAspectRatioValue('0:9')).toBe(1);
    expect(parseAspectRatioValue('16:0')).toBe(1);
  });
});

describe('moveLayoutBox', () => {
  it('平移后越界被收敛', () => {
    const moved = moveLayoutBox({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 0.05, 0.05);
    expect(moved.x).toBeCloseTo(0.15, 6);
    expect(moved.y).toBeCloseTo(0.15, 6);
    expect(moved.w).toBeCloseTo(0.3, 6);
    expect(moved.h).toBeCloseTo(0.3, 6);
    expect(moveLayoutBox({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, -0.5, -0.5)).toEqual({ x: 0, y: 0, w: 0.3, h: 0.3 });
    expect(moveLayoutBox({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 1, 1)).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
  });
});

describe('resizeLayoutBox', () => {
  it('左上角固定，宽高受边界与最小值约束', () => {
    const grown = resizeLayoutBox({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 0.1, 0.1);
    expect(grown.x).toBe(0.2);
    expect(grown.y).toBe(0.2);
    expect(grown.w).toBeCloseTo(0.4, 6);
    expect(grown.h).toBeCloseTo(0.4, 6);
    expect(resizeLayoutBox({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 1, 1)).toEqual({ x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
    expect(resizeLayoutBox({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, -1, -1).w).toBe(MIN_LAYOUT_BOX_SIZE);
  });
});

describe('boxFromPoints', () => {
  it('反向拖拽自动纠正', () => {
    const box = boxFromPoints(0.6, 0.6, 0.2, 0.2);
    expect(box.x).toBeCloseTo(0.2, 6);
    expect(box.y).toBeCloseTo(0.2, 6);
    expect(box.w).toBeCloseTo(0.4, 6);
    expect(box.h).toBeCloseTo(0.4, 6);
  });

  it('零面积拖拽收敛到最小尺寸', () => {
    const box = boxFromPoints(0.5, 0.5, 0.5, 0.5);
    expect(box.w).toBe(MIN_LAYOUT_BOX_SIZE);
    expect(box.h).toBe(MIN_LAYOUT_BOX_SIZE);
  });

  it('越界拖拽被收敛', () => {
    expect(boxFromPoints(-0.5, -0.5, 1.5, 1.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('nextLayoutLabel / nextLayoutObjectId', () => {
  it('避开已占用标签', () => {
    expect(nextLayoutLabel([])).toBe('物体1');
    expect(nextLayoutLabel([obj('obj_1', '物体1', 0.1, 0.1, 0.1, 0.1)])).toBe('物体2');
    expect(nextLayoutLabel([obj('obj_2', '物体2', 0.1, 0.1, 0.1, 0.1)])).toBe('物体1');
  });

  it('避开已占用 id', () => {
    expect(nextLayoutObjectId([])).toBe('obj_1');
    expect(nextLayoutObjectId([obj('obj_1', '甲', 0.1, 0.1, 0.1, 0.1)])).toBe('obj_2');
    expect(nextLayoutObjectId([obj('obj_2', '甲', 0.1, 0.1, 0.1, 0.1)])).toBe('obj_1');
  });
});

describe('LAYOUT_TEMPLATES', () => {
  it('每个模板都能序列化后解析回来', () => {
    for (const template of LAYOUT_TEMPLATES) {
      const parsed = parseLayoutSpec(stringifyLayoutSpec(template.spec));
      expect(parsed, template.id).not.toBeNull();
      expect(parsed?.objects.map((item) => item.label)).toEqual(template.spec.objects.map((item) => item.label));
    }
  });

  it('所有包围盒都在 [0,1] 内且非零面积', () => {
    for (const template of LAYOUT_TEMPLATES) {
      for (const item of template.spec.objects) {
        expect(item.box.x).toBeGreaterThanOrEqual(0);
        expect(item.box.y).toBeGreaterThanOrEqual(0);
        expect(item.box.x + item.box.w).toBeLessThanOrEqual(1.0001);
        expect(item.box.y + item.box.h).toBeLessThanOrEqual(1.0001);
        expect(item.box.w).toBeGreaterThan(0);
        expect(item.box.h).toBeGreaterThan(0);
      }
    }
  });

  it('模板 id 唯一', () => {
    const ids = LAYOUT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getLayoutTemplate 能按 id 取到', () => {
    expect(getLayoutTemplate('ecom-center-hero')?.title).toBe('电商主图居中');
    expect(getLayoutTemplate('not-exist')).toBeUndefined();
  });
});
