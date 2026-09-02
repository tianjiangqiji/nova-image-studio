'use strict';

/**
 * 插件注册表：发现、校验、加载 `backend/plugins/<id>/`。
 *
 * 安装方式就是「管理员把插件目录放进 plugins/」——没有安装器，也没有联网下载。
 * 加载在进程启动时做一次，结果缓存在内存；`reload()` 供开发时手动刷新。
 *
 * 加载失败的插件不会让服务器起不来：它会以 { ok: false, error } 的形式留在列表里，
 * 设置页能直接显示是哪个文件的哪个字段写错了。
 */

const fs = require('fs');
const path = require('path');

const { validatePluginPackage } = require('./validate');

const DEFAULT_PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

/**
 * 插件目录。惰性读取 env 而不是模块加载时固化：server.js 的 loadEnvFile() 在
 * require 之后才跑，固化会让 .env 里的 NOVA_PLUGINS_DIR 失效。
 */
function getPluginsDir() {
  return process.env.NOVA_PLUGINS_DIR || DEFAULT_PLUGINS_DIR;
}

const REQUIRED_FILES = ['manifest.json', 'ui.schema.json', 'provider.json'];

/** @type {{ loadedAt: number, plugins: Map<string, object>, failures: Array<object> } | null} */
let cache = null;

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path.basename(filePath)} 不是合法的 JSON：${error.message}`, { cause: error });
  }
}

function loadOnePlugin(dirName) {
  const dir = path.join(getPluginsDir(), dirName);
  for (const fileName of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, fileName))) {
      throw new Error(`缺少必需文件 ${fileName}`);
    }
  }

  const manifest = readJsonFile(path.join(dir, 'manifest.json'));
  const uiSchema = readJsonFile(path.join(dir, 'ui.schema.json'));
  const provider = readJsonFile(path.join(dir, 'provider.json'));

  const result = validatePluginPackage({ manifest, uiSchema, provider, dirName });
  if (!result.ok) throw new Error(result.message);

  return {
    id: manifest.id,
    dir,
    manifest,
    uiSchema,
    provider,
    // 主机白名单预先小写化，请求前逐个比对
    allowedHosts: new Set(manifest.permissions.hosts.map(host => String(host).toLowerCase())),
  };
}

function scan() {
  const plugins = new Map();
  const failures = [];

  const pluginsDir = getPluginsDir();
  let entries;
  try {
    entries = fs.existsSync(pluginsDir)
      ? fs.readdirSync(pluginsDir, { withFileTypes: true })
      : [];
  } catch (error) {
    console.warn('[plugin-registry] 读取插件目录失败', error && error.message);
    return { loadedAt: Date.now(), plugins, failures };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 以点或下划线开头的目录当作禁用/模板，跳过且不报错
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    try {
      const plugin = loadOnePlugin(entry.name);
      if (plugins.has(plugin.id)) {
        failures.push({ id: entry.name, error: `插件 ID 重复: ${plugin.id}` });
        continue;
      }
      plugins.set(plugin.id, plugin);
      console.log(`[plugin-registry] 已加载插件 ${plugin.id}@${plugin.manifest.version}（${plugin.manifest.models.length} 个模型）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: entry.name, error: message });
      console.warn(`[plugin-registry] 插件 ${entry.name} 加载失败：${message}`);
    }
  }

  return { loadedAt: Date.now(), plugins, failures };
}

function ensureLoaded() {
  if (!cache) cache = scan();
  return cache;
}

function reload() {
  cache = scan();
  return cache;
}

/** 返回可用插件（已通过校验）。 */
function listPlugins() {
  return Array.from(ensureLoaded().plugins.values());
}

/** 加载失败的插件目录及原因，供设置页展示。 */
function listFailures() {
  return ensureLoaded().failures.slice();
}

function getPlugin(pluginId) {
  return ensureLoaded().plugins.get(String(pluginId || '')) || null;
}

/**
 * 前端需要的插件描述。刻意不下发 provider.json——请求模板对界面没有用处，
 * 少一份下发就少一处泄漏上游细节的地方。
 */
function describeForClient(plugin) {
  const { manifest, uiSchema } = plugin;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description || '',
    author: manifest.author || '',
    homepage: manifest.homepage || '',
    outputs: Array.isArray(manifest.outputs) ? manifest.outputs : ['video'],
    credential: {
      source: manifest.credential.source,
      label: manifest.credential.label,
      defaultBaseUrl: manifest.credential.defaultBaseUrl || '',
      helpUrl: manifest.credential.helpUrl || '',
    },
    media: manifest.media || {},
    models: manifest.models.map(model => ({
      id: model.id,
      name: model.name,
      shortName: model.shortName || model.name,
      description: model.description || '',
      price: model.price || null,
    })),
    uiSchema,
  };
}

/** 汇总给 /api/nova/plugins 用的完整载荷。 */
function describeRegistryForClient() {
  const state = ensureLoaded();
  return {
    plugins: Array.from(state.plugins.values()).map(describeForClient),
    failures: state.failures.slice(),
    loadedAt: new Date(state.loadedAt).toISOString(),
    pluginsDir: getPluginsDir(),
  };
}

/** 请求前的主机白名单检查。插件只能访问 manifest 里申报过的主机。 */
function isHostAllowed(plugin, url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return plugin.allowedHosts.has(hostname);
  } catch {
    return false;
  }
}

module.exports = {
  getPluginsDir,
  listPlugins,
  listFailures,
  getPlugin,
  reload,
  describeForClient,
  describeRegistryForClient,
  isHostAllowed,
};
