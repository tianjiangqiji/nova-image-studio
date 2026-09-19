import { describe, expect, it, vi } from "vitest";

const removeItemMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const iterateMock = vi.hoisted(() => vi.fn());

vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({ iterate: iterateMock, removeItem: removeItemMock }),
  },
}));

import { cleanupUnusedMedia, collectMediaStorageKeys } from "../media-storage";

describe("canvas media storage garbage collection", () => {
  it("collects media keys from node metadata", () => {
    const keys = collectMediaStorageKeys({ nodes: [{ metadata: { storageKey: "media:live" } }, { metadata: { storageKey: "image:image" } }] });
    expect(keys).toEqual(new Set(["media:live"]));
  });

  it("removes stored media absent from live metadata", async () => {
    iterateMock.mockImplementation(async (callback: (value: unknown, key: string) => void) => {
      callback(new Blob(["live"]), "media:live");
      callback(new Blob(["dead"]), "media:dead");
    });

    await cleanupUnusedMedia({ nodes: [{ metadata: { storageKey: "media:live" } }] });

    expect(removeItemMock).toHaveBeenCalledWith("media:dead");
    expect(removeItemMock).not.toHaveBeenCalledWith("media:live");
  });
});
