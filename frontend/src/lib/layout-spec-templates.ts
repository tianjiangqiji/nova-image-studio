// 构图规范内置模板
// 全部使用归一化坐标（0–1，原点左上角），覆盖电商主图与定制化海报的常见构图。

import { deriveLayoutRelations, LAYOUT_SPEC_VERSION, type LayoutBox, type LayoutObject, type LayoutSpec } from '@/lib/layout-spec';

export type LayoutTemplateCategory = '电商' | '定制化';

export interface LayoutTemplate {
  id: string;
  title: string;
  description: string;
  category: LayoutTemplateCategory;
  spec: LayoutSpec;
}

function box(x: number, y: number, w: number, h: number): LayoutBox {
  return { x, y, w, h };
}

function objects(items: { id: string; label: string; box: LayoutBox }[]): LayoutObject[] {
  return items.map((item) => ({ id: item.id, label: item.label, box: item.box }));
}

function spec(aspectRatio: string, items: LayoutObject[]): LayoutSpec {
  return {
    version: LAYOUT_SPEC_VERSION,
    aspectRatio,
    objects: items,
    relations: deriveLayoutRelations(items),
  };
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'ecom-center-hero',
    title: '电商主图居中',
    description: '商品居中占主体，四周留白，适合白底主图与平台首图。',
    category: '电商',
    spec: spec(
      '1:1',
      objects([
        { id: 'obj_1', label: '商品主体', box: box(0.26, 0.2, 0.48, 0.6) },
        { id: 'obj_2', label: '背景', box: box(0, 0, 1, 1) },
      ]),
    ),
  },
  {
    id: 'ecom-left-product-right-scene',
    title: '商品左 + 场景右',
    description: '左侧放大商品特写，右侧铺陈使用场景，适合卖点对比与详情页头图。',
    category: '电商',
    spec: spec(
      '16:9',
      objects([
        { id: 'obj_1', label: '商品特写', box: box(0.06, 0.16, 0.4, 0.68) },
        { id: 'obj_2', label: '使用场景', box: box(0.52, 0.12, 0.42, 0.76) },
      ]),
    ),
  },
  {
    id: 'ecom-triptych-compare',
    title: '三联对比',
    description: '横向三等分，适合款式对比、前后效果对比、多规格展示。',
    category: '电商',
    spec: spec(
      '16:9',
      objects([
        { id: 'obj_1', label: '左侧对比项', box: box(0.04, 0.18, 0.27, 0.64) },
        { id: 'obj_2', label: '中间对比项', box: box(0.365, 0.18, 0.27, 0.64) },
        { id: 'obj_3', label: '右侧对比项', box: box(0.69, 0.18, 0.27, 0.64) },
      ]),
    ),
  },
  {
    id: 'ecom-flatlay-topdown',
    title: '平铺俯拍',
    description: '俯视平铺多件道具，商品置于视觉中心，适合套装与配件组合。',
    category: '电商',
    spec: spec(
      '1:1',
      objects([
        { id: 'obj_1', label: '主商品', box: box(0.32, 0.3, 0.36, 0.36) },
        { id: 'obj_2', label: '配件一', box: box(0.08, 0.1, 0.18, 0.18) },
        { id: 'obj_3', label: '配件二', box: box(0.74, 0.12, 0.18, 0.18) },
        { id: 'obj_4', label: '配件三', box: box(0.1, 0.72, 0.2, 0.18) },
        { id: 'obj_5', label: '配件四', box: box(0.72, 0.7, 0.18, 0.18) },
      ]),
    ),
  },
  {
    id: 'poster-figure-product',
    title: '人物 + 产品',
    description: '左侧人物出镜，右侧产品与文案区，适合代言与种草海报。',
    category: '定制化',
    spec: spec(
      '3:4',
      objects([
        { id: 'obj_1', label: '人物', box: box(0.04, 0.1, 0.42, 0.8) },
        { id: 'obj_2', label: '产品', box: box(0.54, 0.28, 0.34, 0.34) },
        { id: 'obj_3', label: '文案区', box: box(0.54, 0.68, 0.34, 0.18) },
      ]),
    ),
  },
  {
    id: 'poster-whitespace-headline',
    title: '定制海报留白',
    description: '主体压在下方三分之一，上方大面积留白给标题与 Logo。',
    category: '定制化',
    spec: spec(
      '3:4',
      objects([
        { id: 'obj_1', label: '标题留白区', box: box(0.08, 0.08, 0.84, 0.3) },
        { id: 'obj_2', label: '视觉主体', box: box(0.16, 0.44, 0.68, 0.46) },
      ]),
    ),
  },
  {
    id: 'poster-three-column',
    title: '左中右三栏',
    description: '经典三栏信息结构，适合功能罗列、三步说明、卖点拆解。',
    category: '定制化',
    spec: spec(
      '16:9',
      objects([
        { id: 'obj_1', label: '左栏内容', box: box(0.05, 0.22, 0.26, 0.56) },
        { id: 'obj_2', label: '中栏内容', box: box(0.37, 0.22, 0.26, 0.56) },
        { id: 'obj_3', label: '右栏内容', box: box(0.69, 0.22, 0.26, 0.56) },
      ]),
    ),
  },
];

export function getLayoutTemplate(id: string): LayoutTemplate | undefined {
  return LAYOUT_TEMPLATES.find((template) => template.id === id);
}

export const LAYOUT_TEMPLATE_CATEGORIES: LayoutTemplateCategory[] = ['电商', '定制化'];
