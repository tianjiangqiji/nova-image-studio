import { describe, expect, it } from 'vitest';

import {
  calculateDraggedSliceRadius,
  clampNumber,
  computeSnap,
  describeSourceImageSizeError,
  getSliceFieldMax,
  getSliceRadii,
  hasSlicePlacementChanged,
  isZeroRadii,
  MAX_SOURCE_IMAGE_DIMENSION,
  movePlacement,
  normalizeDraftRect,
  normalizeSlicePlacement,
  rectsIntersect,
  resizePlacement,
  setSliceCornerRadius,
  setUniformRadius,
} from '@/lib/slice-geometry';
import type { SlicePlacement, SliceScreen } from '@/lib/slice-types';

const screen: SliceScreen = { width: 750, height: 1334 };

function place(x: number, y: number, width: number, height: number): SlicePlacement {
  return { x, y, width, height };
}

describe('clampNumber', () => {
  it('clamps into range', () => {
    expect(clampNumber(5, 0, 10, 0)).toBe(5);
    expect(clampNumber(-3, 0, 10, 0)).toBe(0);
    expect(clampNumber(99, 0, 10, 0)).toBe(10);
  });

  it('falls back on non-finite input instead of collapsing to 0', () => {
    // 数字输入框清空时保留原值，这是与源项目一致的行为
    expect(clampNumber('', 0, 10, 7)).toBe(7);
    expect(clampNumber(NaN, 0, 10, 7)).toBe(7);
    expect(clampNumber(undefined, 0, 10, 7)).toBe(7);
    expect(clampNumber(Infinity, 0, 10, 7)).toBe(7);
  });
});

describe('getSliceFieldMax', () => {
  it('bounds x/y so the slice cannot leave the canvas', () => {
    expect(getSliceFieldMax(place(0, 0, 100, 200), 'x', screen)).toBe(650);
    expect(getSliceFieldMax(place(0, 0, 100, 200), 'y', screen)).toBe(1134);
  });

  it('bounds width/height by the remaining space from the origin', () => {
    expect(getSliceFieldMax(place(700, 1300, 10, 10), 'width', screen)).toBe(50);
    expect(getSliceFieldMax(place(700, 1300, 10, 10), 'height', screen)).toBe(34);
  });

  it('bounds radius by half the short side', () => {
    expect(getSliceFieldMax(place(0, 0, 100, 40), 'radius', screen)).toBe(20);
    expect(getSliceFieldMax(place(0, 0, 41, 100), 'radius', screen)).toBe(20);
  });
});

describe('getSliceRadii', () => {
  it('derives four corners from the legacy scalar radius', () => {
    // 旧记录只有 radius，没有 radii —— 这是免迁移的关键
    const radii = getSliceRadii({ placement: place(0, 0, 100, 100), radius: 12 }, screen);
    expect(radii).toEqual({ topLeft: 12, topRight: 12, bottomRight: 12, bottomLeft: 12 });
  });

  it('prefers explicit radii over the scalar', () => {
    const radii = getSliceRadii(
      {
        placement: place(0, 0, 100, 100),
        radius: 12,
        radii: { topLeft: 4, topRight: 0, bottomRight: 8, bottomLeft: 0 },
      },
      screen,
    );
    expect(radii).toEqual({ topLeft: 4, topRight: 0, bottomRight: 8, bottomLeft: 0 });
  });

  it('clamps every corner to half the short side', () => {
    const radii = getSliceRadii(
      {
        placement: place(0, 0, 100, 30),
        radii: { topLeft: 999, topRight: 20, bottomRight: -5, bottomLeft: 0 },
      },
      screen,
    );
    expect(radii.topLeft).toBe(15);
    expect(radii.topRight).toBe(15);
    expect(radii.bottomRight).toBe(0);
  });

  it('treats a missing radius as zero', () => {
    expect(isZeroRadii(getSliceRadii({ placement: place(0, 0, 50, 50) }, screen))).toBe(true);
  });
});

describe('setSliceCornerRadius / setUniformRadius', () => {
  it('changes only the targeted corner and keeps radius as the max', () => {
    const asset = { placement: place(0, 0, 100, 100), radius: 0 };
    const next = setSliceCornerRadius(asset, 'bottomLeft', 24, screen);
    expect(next.radii).toEqual({ topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 24 });
    expect(next.radius).toBe(24);
  });

  it('sets all four corners uniformly', () => {
    const next = setUniformRadius({ placement: place(0, 0, 100, 100) }, 16, screen);
    expect(next.radii).toEqual({ topLeft: 16, topRight: 16, bottomRight: 16, bottomLeft: 16 });
    expect(next.radius).toBe(16);
  });
});

describe('normalizeSlicePlacement', () => {
  it('rounds and clamps arbitrary input into the canvas', () => {
    expect(normalizeSlicePlacement({ x: -50, y: -50, width: 10.4, height: 10.6 }, screen)).toEqual(
      place(0, 0, 10, 11),
    );
  });

  it('shrinks an oversized rect to the remaining space', () => {
    expect(normalizeSlicePlacement({ x: 700, y: 1300, width: 500, height: 500 }, screen)).toEqual(
      place(700, 1300, 50, 34),
    );
  });
});

describe('movePlacement', () => {
  it('keeps the size and clamps at the canvas edge', () => {
    const start = place(100, 100, 200, 300);
    expect(movePlacement(start, 50, -30, screen)).toEqual(place(150, 70, 200, 300));
    // 顶住右下边界而不是越界
    const pinned = movePlacement(start, 9999, 9999, screen);
    expect(pinned).toEqual(place(550, 1034, 200, 300));
    expect(pinned.x + pinned.width).toBe(screen.width);
    expect(pinned.y + pinned.height).toBe(screen.height);
  });

  it('clamps at the origin', () => {
    expect(movePlacement(place(10, 10, 50, 50), -9999, -9999, screen)).toEqual(place(0, 0, 50, 50));
  });
});

describe('resizePlacement', () => {
  const start = place(100, 100, 200, 200);

  it('moves only the edges named by the handle', () => {
    expect(resizePlacement(start, 'se', 40, 60, screen)).toEqual(place(100, 100, 240, 260));
    expect(resizePlacement(start, 'nw', 40, 60, screen)).toEqual(place(140, 160, 160, 140));
    // 边中点：另一个轴完全不动
    expect(resizePlacement(start, 'e', 40, 999, screen)).toEqual(place(100, 100, 240, 200));
    expect(resizePlacement(start, 'n', 999, 40, screen)).toEqual(place(100, 140, 200, 160));
    expect(resizePlacement(start, 'w', -40, 999, screen)).toEqual(place(60, 100, 240, 200));
    expect(resizePlacement(start, 's', 999, -40, screen)).toEqual(place(100, 100, 200, 160));
  });

  it('never shrinks below minSize', () => {
    const result = resizePlacement(start, 'se', -9999, -9999, screen, 8);
    expect(result.width).toBe(8);
    expect(result.height).toBe(8);
  });

  it('never grows past the canvas', () => {
    const result = resizePlacement(start, 'se', 9999, 9999, screen);
    expect(result.x + result.width).toBe(screen.width);
    expect(result.y + result.height).toBe(screen.height);
  });

  it('never pushes the origin negative', () => {
    const result = resizePlacement(start, 'nw', -9999, -9999, screen);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});

describe('normalizeDraftRect', () => {
  it('works regardless of drag direction', () => {
    expect(normalizeDraftRect(300, 400, 100, 200, screen)).toEqual(place(100, 200, 200, 200));
    expect(normalizeDraftRect(100, 200, 300, 400, screen)).toEqual(place(100, 200, 200, 200));
  });

  it('clamps to the canvas', () => {
    expect(normalizeDraftRect(-100, -100, 9999, 9999, screen)).toEqual(
      place(0, 0, screen.width, screen.height),
    );
  });
});

describe('calculateDraggedSliceRadius', () => {
  it('grows when dragging inward and shrinks when dragging outward', () => {
    // 左上角向内 = 右下方向
    expect(calculateDraggedSliceRadius('topLeft', 0, 20, 20, 50)).toBe(20);
    expect(calculateDraggedSliceRadius('topLeft', 20, -20, -20, 50)).toBe(0);
    // 右上角向内 = 左下方向
    expect(calculateDraggedSliceRadius('topRight', 0, -20, 20, 50)).toBe(20);
    // 右下角向内 = 左上方向
    expect(calculateDraggedSliceRadius('bottomRight', 0, -20, -20, 50)).toBe(20);
    // 左下角向内 = 右上方向
    expect(calculateDraggedSliceRadius('bottomLeft', 0, 20, -20, 50)).toBe(20);
  });

  it('clamps to [0, maxRadius]', () => {
    expect(calculateDraggedSliceRadius('topLeft', 0, 9999, 9999, 50)).toBe(50);
    expect(calculateDraggedSliceRadius('topLeft', 0, -9999, -9999, 50)).toBe(0);
  });
});

describe('hasSlicePlacementChanged', () => {
  it('detects any field change and ignores identity', () => {
    const a = place(1, 2, 3, 4);
    expect(hasSlicePlacementChanged(a, place(1, 2, 3, 4))).toBe(false);
    expect(hasSlicePlacementChanged(a, place(9, 2, 3, 4))).toBe(true);
    expect(hasSlicePlacementChanged(a, place(1, 2, 3, 9))).toBe(true);
  });
});

describe('rectsIntersect', () => {
  it('reports overlap, edge contact, and separation', () => {
    expect(rectsIntersect(place(0, 0, 10, 10), place(5, 5, 10, 10))).toBe(true);
    expect(rectsIntersect(place(0, 0, 10, 10), place(10, 0, 10, 10))).toBe(true);
    expect(rectsIntersect(place(0, 0, 10, 10), place(11, 0, 10, 10))).toBe(false);
    expect(rectsIntersect(place(0, 0, 10, 10), place(0, 11, 10, 10))).toBe(false);
  });
});

describe('computeSnap', () => {
  it('snaps a near-aligned left edge onto another slice', () => {
    const moving = place(98, 500, 50, 50);
    const other = place(100, 900, 50, 50);
    const { dx, guides } = computeSnap(moving, [other], screen, 4);
    expect(dx).toBe(2);
    expect(guides).toEqual(expect.arrayContaining([{ axis: 'x', position: 100 }]));
  });

  it('snaps to the canvas centre line', () => {
    // 边 300 / 中线 320 / 右边 340，距画布中线 375 最近也有 35px，不吸附
    expect(computeSnap(place(300, 500, 40, 20), [], screen, 4).dx).toBe(0);
    // 中线 374，距画布中线 375 只差 1px
    expect(computeSnap(place(336, 10, 76, 20), [], screen, 4).dx).toBe(1);
  });

  it('picks the closest candidate when several are in range', () => {
    const moving = place(100, 10, 50, 20);
    const others = [place(103, 500, 10, 10), place(101, 600, 10, 10)];
    expect(computeSnap(moving, others, screen, 5).dx).toBe(1);
  });

  it('returns no correction when nothing is within the threshold', () => {
    const result = computeSnap(place(300, 600, 50, 50), [place(500, 900, 10, 10)], screen, 4);
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('snaps both axes independently', () => {
    const moving = place(98, 198, 50, 50);
    const others = [place(100, 900, 10, 10), place(600, 200, 10, 10)];
    const { dx, dy } = computeSnap(moving, others, screen, 4);
    expect(dx).toBe(2);
    expect(dy).toBe(2);
  });
});

describe('describeSourceImageSizeError', () => {
  it('accepts a size at the upper bound', () => {
    expect(
      describeSourceImageSizeError(MAX_SOURCE_IMAGE_DIMENSION, MAX_SOURCE_IMAGE_DIMENSION),
    ).toBeNull();
  });

  it('rejects an oversized width and reports the actual size', () => {
    const message = describeSourceImageSizeError(5000, 3000);
    expect(message).toContain('5000 × 3000');
    expect(message).toContain(String(MAX_SOURCE_IMAGE_DIMENSION));
  });

  it('rejects an oversized height', () => {
    expect(describeSourceImageSizeError(1000, MAX_SOURCE_IMAGE_DIMENSION + 1)).not.toBeNull();
  });

  it('rejects zero, negative, and non-finite sizes', () => {
    expect(describeSourceImageSizeError(0, 100)).toBe('图片尺寸无效，请重新选择图片。');
    expect(describeSourceImageSizeError(100, -1)).toBe('图片尺寸无效，请重新选择图片。');
    expect(describeSourceImageSizeError(Number.NaN, 100)).toBe('图片尺寸无效，请重新选择图片。');
  });
});
