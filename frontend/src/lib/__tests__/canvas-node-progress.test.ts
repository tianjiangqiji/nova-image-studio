import { describe, expect, it } from "vitest";

import { computeNodeProgress } from "../../components/canvas/components/canvas-node-progress-overlay";

const KB = 1024;
const MB = 1024 * 1024;

function item(bytes: number, loaded: number, status = "uploading") {
  return { bytes, loaded, status };
}

describe("computeNodeProgress", () => {
  it("空素材纯生成：uploadRatio 视为 1，totalPercent 只看生成进度", () => {
    expect(computeNodeProgress([], 80)).toEqual({
      uploadRatio: 1,
      genRatio: 0.8,
      totalPercent: 80,
      uploadDoneCount: 0,
      uploadTotalCount: 0,
    });
  });

  it("空素材且上游未返回进度：totalPercent 为 null（交给不定动画）", () => {
    expect(computeNodeProgress([], undefined)).toMatchObject({ uploadRatio: 1, genRatio: null, totalPercent: null });
    expect(computeNodeProgress([], null)).toMatchObject({ genRatio: null, totalPercent: null });
  });

  it("有素材无进度：uploadRatio 照常计算，totalPercent 为 null", () => {
    const summary = computeNodeProgress([item(1000, 400), item(1000, 1000, "done")]);

    expect(summary.uploadRatio).toBeCloseTo(0.7);
    expect(summary.genRatio).toBeNull();
    expect(summary.totalPercent).toBeNull();
    expect(summary.uploadDoneCount).toBe(1);
    expect(summary.uploadTotalCount).toBe(2);
  });

  it("有素材有进度：按 0.4/0.6 权重合成", () => {
    // uploadRatio = (400+1000)/(1000+1000) = 0.7，genRatio = 0.5
    const summary = computeNodeProgress([item(1000, 400), item(1000, 1000, "done")], 50);

    expect(summary.uploadRatio).toBeCloseTo(0.7);
    expect(summary.genRatio).toBeCloseTo(0.5);
    expect(summary.totalPercent).toBeCloseTo((0.7 * 0.4 + 0.5 * 0.6) * 100);
  });

  it("字节加权：30MB 视频装载一半 + 200KB 图片已完成", () => {
    const videoBytes = 30 * MB;
    const imageBytes = 200 * KB;
    const summary = computeNodeProgress([item(videoBytes, videoBytes / 2), item(imageBytes, imageBytes, "done")], 0);

    const expectedRatio = (videoBytes / 2 + imageBytes) / (videoBytes + imageBytes);
    expect(summary.uploadRatio).toBeCloseTo(expectedRatio);
    // 不按字节加权（两项各占一半）会得到 0.75；加权后大文件主导，应贴近视频自身的 0.5
    expect(summary.uploadRatio).toBeLessThan(0.51);
    expect(summary.uploadDoneCount).toBe(1);
    expect(summary.uploadTotalCount).toBe(2);
    // genRatio = 0（真值，不是 null）：totalPercent = uploadRatio*0.4*100
    expect(summary.totalPercent).toBeCloseTo(expectedRatio * 0.4 * 100);
  });

  it("loaded 超过 bytes 时按 bytes 截断，不出现 >1 的比例", () => {
    const summary = computeNodeProgress([item(100, 500, "uploading")]);

    expect(summary.uploadRatio).toBe(1);
  });

  it("bytes 总和为 0 时退化为按完成个数比", () => {
    const summary = computeNodeProgress([item(0, 0, "done"), item(0, 0, "uploading")], 40);

    expect(summary.uploadRatio).toBe(0.5);
    expect(summary.totalPercent).toBeCloseTo((0.5 * 0.4 + 0.4 * 0.6) * 100);
  });

  it("videoProgress 边界：0 / 50 / 100", () => {
    expect(computeNodeProgress([], 0)).toMatchObject({ genRatio: 0, totalPercent: 0 });
    expect(computeNodeProgress([], 50)).toMatchObject({ genRatio: 0.5, totalPercent: 50 });
    expect(computeNodeProgress([], 100)).toMatchObject({ genRatio: 1, totalPercent: 100 });
  });
});
