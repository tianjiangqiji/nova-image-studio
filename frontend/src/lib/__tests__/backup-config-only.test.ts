import { describe, expect, it, vi } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const localForageStores = vi.hoisted(() => new Map<string, Record<string, unknown>>([
  ['canvas_app_state', {}],
  ['canvas_image_files', {}],
  ['canvas_media_files', {}],
]));

vi.mock('localforage', () => ({
  default: {
    createInstance: ({ storeName }: { storeName: string }) => ({
      iterate: async (callback: (value: unknown, key: string) => void) => {
        for (const [key, value] of Object.entries(localForageStores.get(storeName) ?? {})) callback(value, key);
      },
      clear: async () => localForageStores.set(storeName, {}),
      setItem: async (key: string, value: unknown) => {
        localForageStores.set(storeName, { ...(localForageStores.get(storeName) ?? {}), [key]: value });
      },
    }),
  },
}));

import {
  exportAllData,
  importAllData,
  generateBackupFilename,
  shouldSkipDbInConfigOnlyBackup,
  shouldSkipLocalForageStoreInConfigOnlyBackup,
} from '@/lib/backup-utils';

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('仅配置导出', () => {
  it('跳过图片/素材/生成结果/缓存类库', () => {
    for (const db of ['nova-image-db', 'nova-upload-cache', 'nova-assets-db', 'nova-reverse-db', 'nova-slice-db']) {
      expect(shouldSkipDbInConfigOnlyBackup(db)).toBe(true);
    }
  });

  it('保留配置与会话文字记录所在的库', () => {
    expect(shouldSkipDbInConfigOnlyBackup('nova-agent-db')).toBe(false);
  });

  it('跳过画布图片和媒体文件，保留画布状态', () => {
    expect(shouldSkipLocalForageStoreInConfigOnlyBackup('canvas_image_files')).toBe(true);
    expect(shouldSkipLocalForageStoreInConfigOnlyBackup('canvas_media_files')).toBe(true);
    expect(shouldSkipLocalForageStoreInConfigOnlyBackup('canvas_app_state')).toBe(false);
  });

  it('完整备份包含画布媒体 store，配置备份不含媒体字节', async () => {
    const mediaBlob = new Blob(['media'], { type: 'video/mp4' });
    Object.defineProperty(mediaBlob, 'arrayBuffer', { value: async () => new TextEncoder().encode('media').buffer });
    localForageStores.set('canvas_media_files', { 'media:live': mediaBlob });
    const fullBlob = await exportAllData();
    const full = unzipSync(await readBlob(fullBlob));
    const fullLocalForage = JSON.parse(new TextDecoder().decode(full['localforage/nova-image.json'])) as Record<string, Record<string, unknown>>;
    expect(fullLocalForage.canvas_media_files).toBeDefined();
    expect(Object.keys(full).some((path) => path.startsWith('blobs/'))).toBe(true);

    const configBlob = await exportAllData(undefined, { includeImages: false });
    const config = unzipSync(await readBlob(configBlob));
    const configLocalForage = JSON.parse(new TextDecoder().decode(config['localforage/nova-image.json'])) as Record<string, Record<string, unknown>>;
    expect(configLocalForage.canvas_media_files).toBeUndefined();
    expect(Object.keys(config).some((path) => path.startsWith('blobs/'))).toBe(false);
    expect(config['metadata.json']).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(config['metadata.json'])).backupMode).toBe('config');
  });

  it('完整备份导入会恢复画布媒体字节', async () => {
    const zip = zipSync({
      'metadata.json': strToU8(JSON.stringify({ backupMode: 'full' })),
      'localStorage.json': strToU8('{}'),
      'localforage/nova-image.json': strToU8(JSON.stringify({
        canvas_media_files: [{ key: 'media:restored', _blobRef: 'media-ref', _blobMimeType: 'video/mp4' }],
      })),
      'blobs/media-ref': strToU8('media'),
    });
    const file = new File([zip], 'nova-backup.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => zip.buffer });
    await importAllData(file);

    expect(localForageStores.get('canvas_media_files')?.['media:restored']).toBeInstanceOf(Blob);
  });

  it('导入仅配置备份时明确提示不含媒体', async () => {
    const zip = zipSync({
      'metadata.json': strToU8(JSON.stringify({ backupMode: 'config' })),
      'localStorage.json': strToU8('{}'),
    });
    const file = new File([zip], 'nova-config.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => zip.buffer });
    const warnings = await importAllData(file);
    expect(warnings).toContain('这是仅配置备份，不包含画布图片和媒体文件；相关引用不会恢复');
  });

  it('文件名区分全量与仅配置', () => {
    expect(generateBackupFilename(false)).toMatch(/^nova-backup-.*\.zip$/);
    expect(generateBackupFilename(true)).toMatch(/^nova-config-.*\.zip$/);
  });
});
