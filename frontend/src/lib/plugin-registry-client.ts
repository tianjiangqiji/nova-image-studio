'use client';

/**
 * 已安装插件的读取，以及每个插件的凭据（apiKey / baseUrl）本地存储。
 *
 * 插件的安装是管理员把目录放进 backend/plugins/——前端只能读，不能装、不能删。
 * 凭据放浏览器 localStorage，与开源版图片模型「每个模型各存一份 key」的做法一致：
 * 同一个部署下多个人各用自己的 key，服务器不持有任何人的密钥。
 */

import { applyMediaLimits } from '@/lib/plugin-media-config';
import type { InstalledPlugin } from '@/lib/plugin-schema';

export interface PluginLoadFailure {
  id: string;
  error: string;
}

export interface PluginRegistrySnapshot {
  plugins: InstalledPlugin[];
  failures: PluginLoadFailure[];
  loadedAt: string;
  pluginsDir: string;
}

const EMPTY_SNAPSHOT: PluginRegistrySnapshot = {
  plugins: [],
  failures: [],
  loadedAt: '',
  pluginsDir: '',
};

/**
 * 插件清单在一次会话里基本不变（要变得管理员上服务器放文件并重启），
 * 所以取一次就缓存，多个组件共享同一个 in-flight promise。
 */
let cache: PluginRegistrySnapshot | null = null;
let inFlight: Promise<PluginRegistrySnapshot> | null = null;

type Listener = (snapshot: PluginRegistrySnapshot) => void;
const listeners = new Set<Listener>();

function notify(snapshot: PluginRegistrySnapshot): void {
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[plugin-registry] error notifying listener', error);
    }
  }
}

export function subscribePluginRegistry(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore 用：引用稳定，未加载完成前返回空快照。 */
export function getPluginRegistrySnapshot(): PluginRegistrySnapshot {
  return cache ?? EMPTY_SNAPSHOT;
}

export function getPluginRegistryServerSnapshot(): PluginRegistrySnapshot {
  return EMPTY_SNAPSHOT;
}

/**
 * 读取已安装插件。
 * @param force true 时绕过前端缓存，并让后端重新扫描插件目录——管理员放完插件后
 *   不用重启后端就能看到。
 */
export async function loadPluginRegistry(force = false): Promise<PluginRegistrySnapshot> {
  if (!force && cache) return cache;
  if (!force && inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(force ? '/api/nova/plugins?reload=1' : '/api/nova/plugins', { cache: 'no-store' });
      if (!response.ok) throw new Error(`读取插件列表失败: ${response.status}`);
      const data = await response.json();
      // 素材格式与体积上限随插件列表一起下发，省一次请求
      applyMediaLimits(data?.mediaLimits);
      const snapshot: PluginRegistrySnapshot = {
        plugins: Array.isArray(data?.plugins) ? data.plugins : [],
        failures: Array.isArray(data?.failures) ? data.failures : [],
        loadedAt: typeof data?.loadedAt === 'string' ? data.loadedAt : '',
        pluginsDir: typeof data?.pluginsDir === 'string' ? data.pluginsDir : '',
      };
      cache = snapshot;
      notify(snapshot);
      return snapshot;
    } catch (error) {
      console.warn('[plugin-registry] 读取插件列表失败', error);
      // 读不到就当没装插件：界面会显示引导文案，而不是空白或崩溃
      cache = EMPTY_SNAPSHOT;
      notify(EMPTY_SNAPSHOT);
      return EMPTY_SNAPSHOT;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// ===== 插件凭据 =====

const CREDENTIALS_KEY = 'nova-plugin-credentials';

export interface PluginCredential {
  apiKey: string;
  baseUrl: string;
}

type CredentialMap = Record<string, PluginCredential>;

const credentialListeners = new Set<() => void>();
/**
 * 凭据的版本号。useSyncExternalStore 需要一个「值变了」的稳定信号，
 * 而凭据本身是每次读都新建的对象，不能直接当快照用。
 */
let credentialVersion = 0;

export function getCredentialVersion(): number {
  return credentialVersion;
}

export function subscribePluginCredentials(listener: () => void): () => void {
  credentialListeners.add(listener);
  return () => {
    credentialListeners.delete(listener);
  };
}

function readCredentialMap(): CredentialMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CREDENTIALS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CredentialMap) : {};
  } catch {
    return {};
  }
}

/** 读某个插件的凭据。baseUrl 缺省时回落到插件申报的默认地址。 */
export function getPluginCredential(plugin: InstalledPlugin): PluginCredential {
  const stored = readCredentialMap()[plugin.id];
  return {
    apiKey: stored?.apiKey || '',
    baseUrl: stored?.baseUrl || plugin.credential.defaultBaseUrl || '',
  };
}

export function setPluginCredential(pluginId: string, credential: Partial<PluginCredential>): void {
  if (typeof window === 'undefined') return;
  const map = readCredentialMap();
  const current = map[pluginId] || { apiKey: '', baseUrl: '' };
  map[pluginId] = {
    apiKey: credential.apiKey !== undefined ? credential.apiKey.trim() : current.apiKey,
    baseUrl: credential.baseUrl !== undefined ? credential.baseUrl.trim() : current.baseUrl,
  };
  try {
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(map));
  } catch (error) {
    console.error('[plugin-registry] 保存插件凭据失败', error);
  }
  credentialVersion += 1;
  for (const listener of credentialListeners) listener();
}

export function hasPluginCredential(plugin: InstalledPlugin): boolean {
  return getPluginCredential(plugin).apiKey.length > 0;
}

// ===== 最近使用的插件 =====

const LAST_PLUGIN_KEY = 'nova-plugin-last-used';

export function getLastUsedPluginId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(LAST_PLUGIN_KEY) || '';
  } catch {
    return '';
  }
}

export function setLastUsedPluginId(pluginId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LAST_PLUGIN_KEY, pluginId);
  } catch {
    /* 隐私模式下写不进去，不影响使用 */
  }
}
