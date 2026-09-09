import { cleanupUnusedImages } from "./image-storage";
import { cleanupUnusedMedia } from "./media-storage";

export async function cleanupUnusedCanvasStorage(usedData: unknown): Promise<void> {
  await Promise.allSettled([cleanupUnusedImages(usedData), cleanupUnusedMedia(usedData)]);
}
