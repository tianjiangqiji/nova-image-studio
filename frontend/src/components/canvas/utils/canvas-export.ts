import { createZip, readZip } from "../lib/zip";
import { saveAs } from "../lib/file-save";
import { getImageBlob, setImageBlob } from "../lib/image-storage";
import { getMediaBlob, isMediaStorageKey, setMediaBlob } from "../lib/media-storage";
import type { CanvasExportAsset, CanvasExportFile } from "../export-types";
import type { CanvasProject } from "../stores/use-canvas-store";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "无限画布") {
  const zipFiles: { name: string; data: BlobPart }[] = [];
  const exportedProjects = await Promise.all(
    projects.map(async (project) => {
      const files: CanvasExportAsset[] = [];
      await Promise.all(
        collectStorageKeys(project).map(async (storageKey) => {
          // 图片与音视频分别存在两个 IndexedDB store，按前缀取
          const blob = isMediaStorageKey(storageKey)
            ? await getMediaBlob(storageKey)
            : storageKey.startsWith("image:")
              ? await getImageBlob(storageKey)
              : null;
          if (!blob) return;
          const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
          files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
          zipFiles.push({ name: path, data: blob });
        }),
      );
      return { project, files };
    }),
  );

  const data: CanvasExportFile = { app: "nova-image-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
  const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
  saveAs(zip, `${safeFileName(fileName)}.zip`);
}

/** 从导出 zip 还原图片/音视频 blob 到 IndexedDB，并返回可供 importProject 的项目列表。 */
export async function importCanvasProjectsFromZip(file: Blob): Promise<Partial<CanvasProject>[]> {
  const zip = await readZip(file);
  const projectFile = zip.get("projects.json");
  if (!projectFile) throw new Error("缺少 projects.json");
  const data = JSON.parse(await projectFile.text()) as CanvasExportFile;

  await Promise.all(
    (data.projects || []).flatMap((entry) =>
      (entry.files || []).map(async (item) => {
        const blob = zip.get(item.path);
        if (!blob) return;
        const typedBlob = item.mimeType ? new Blob([blob], { type: item.mimeType }) : blob;
        if (isMediaStorageKey(item.storageKey)) await setMediaBlob(item.storageKey, typedBlob);
        else if (item.storageKey.startsWith("image:")) await setImageBlob(item.storageKey, typedBlob);
      }),
    ),
  );

  return (data.projects || []).map((entry) => entry.project);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return [...keys];
  if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || isMediaStorageKey(value.storageKey))) {
    keys.add(value.storageKey);
  }
  Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
  return [...keys];
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return storageKey.startsWith("image:") ? "png" : "bin";
}
