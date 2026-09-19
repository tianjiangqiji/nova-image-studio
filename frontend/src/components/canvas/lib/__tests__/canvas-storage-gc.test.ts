import { describe, expect, it, vi } from "vitest";

const cleanupUnusedImagesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cleanupUnusedMediaMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../image-storage", () => ({ cleanupUnusedImages: cleanupUnusedImagesMock }));
vi.mock("../media-storage", () => ({ cleanupUnusedMedia: cleanupUnusedMediaMock }));

import { cleanupUnusedCanvasStorage } from "../canvas-storage-gc";

describe("canvas storage garbage collection", () => {
  it("passes remaining canvas data to both image and media collectors", async () => {
    const remaining = [{ id: "project", nodes: [{ metadata: { storageKey: "image:live" } }] }];

    await cleanupUnusedCanvasStorage(remaining);

    expect(cleanupUnusedImagesMock).toHaveBeenCalledWith(remaining);
    expect(cleanupUnusedMediaMock).toHaveBeenCalledWith(remaining);
  });

  it("does not reject when one storage collector fails", async () => {
    cleanupUnusedImagesMock.mockRejectedValueOnce(new Error("image storage unavailable"));

    await expect(cleanupUnusedCanvasStorage([])).resolves.toBeUndefined();
  });
});
