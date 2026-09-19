// Nova Image Studio 桌面壳（Electron 主进程）
// 内嵌 backend/server.js：该文件被 require 即自启动并读取 env，
// 因此所有环境变量必须在 require 之前设置完毕。
const { app, BrowserWindow, Menu, dialog, net: electronNet } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BACKEND_ENTRY = path.join(__dirname, '..', 'backend', 'server.js');
const BACKEND_READY_TIMEOUT_MS = 30 * 1000;
const BACKEND_READY_POLL_MS = 300;

let mainWindow = null;

// 数据必须落在「你双击的那个 exe 旁边」，不能落在 portable 每次解压的临时目录。
// electron-builder portable 会把 exe 解到 %TEMP%\... 再启动，app.getPath('exe')
// 指向临时副本；真正的 C:\nova 在 PORTABLE_EXECUTABLE_DIR。
function resolveUserDataDir() {
  if (process.env.NOVA_DATA_DIR) return process.env.NOVA_DATA_DIR;
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableRoot) return path.join(portableRoot, 'data');
  if (app.isPackaged && process.platform === 'win32') {
    return path.join(path.dirname(process.execPath), 'data');
  }
  return null;
}

const resolvedUserDataDir = resolveUserDataDir();
if (resolvedUserDataDir) {
  app.setPath('userData', resolvedUserDataDir);
}

// 桌面壳自己的 DevTools 端口默认关闭。仅在显式设置
// NOVA_ELECTRON_CDP_ENABLED=true 时开启，并强制只监听本机回环地址。
// 与用户浏览器调试口（9222/9224）分开，避免抢端口。
const ELECTRON_CDP_ENABLED = String(process.env.NOVA_ELECTRON_CDP_ENABLED ?? 'false').toLowerCase() === 'true';
if (ELECTRON_CDP_ENABLED) {
  const ELECTRON_CDP_PORT = parseInt(process.env.NOVA_ELECTRON_CDP_PORT || '9333', 10);
  if (Number.isInteger(ELECTRON_CDP_PORT) && ELECTRON_CDP_PORT > 0) {
    app.commandLine.appendSwitch('remote-debugging-port', String(ELECTRON_CDP_PORT));
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
}

// 内嵌后端出网策略：直连优先，失败才回落系统代理。
// 背景：Clash/VPN 用户的环境里，两类站点并存——
//   · superxihe.com 直连被 Cloudflare 拦（返回 HTML 拦截页），必须走代理；
//   · 部分上游网关走代理会被 forbid，必须直连。
// 因此不能全局直连（原 Node fetch 行为），也不能全局代理。
// 判定规则：直连抛网络错误，或返回 4xx/5xx 且 Content-Type 是 HTML
// （典型的 Cloudflare/WAF 拦截页），改用 Electron Chromium 网络栈
// （自动吃系统代理）重试一次。回环地址始终 Node 直连（CDP、健康检查）。
function installProxiedFetch() {
  const nodeFetch = global.fetch;
  if (typeof nodeFetch !== 'function') return;
  global.fetch = async (input, init) => {
    let hostname = '';
    try {
      const raw = typeof input === 'string' ? input : input && input.url;
      hostname = new URL(raw).hostname;
    } catch { /* 解析失败按非回环处理 */ }
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
      return nodeFetch(input, init);
    }
    try {
      const direct = await nodeFetch(input, init);
      const contentType = direct.headers.get('content-type') || '';
      const looksLikeWafBlock = direct.status >= 400 && contentType.includes('text/html');
      if (!looksLikeWafBlock) return direct;
      console.warn(`[network] 直连 ${hostname} 返回 HTTP ${direct.status} HTML 拦截页，改用系统代理重试`);
    } catch (error) {
      console.warn(`[network] 直连 ${hostname} 失败（${error && error.message}），改用系统代理重试`);
    }
    return electronNet.fetch(input, init);
  };
}

// 后端端口必须固定：页面以 http://127.0.0.1:<port> 为 origin，
// localStorage / IndexedDB 都按 origin 隔离。随机端口 = 每次启动换个
// “新网站”，用户配置、素材、对话记录全部“丢失”（数据其实还在旧 origin 里）。
// 默认固定 31207；被占用时递增重试几次，仍不行才退回随机端口兜底。
const BACKEND_PORT_START = parseInt(process.env.NOVA_BACKEND_PORT || '31207', 10);
const BACKEND_PORT_MAX_ATTEMPTS = 10;

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(port));
    });
  });
}

async function resolveBackendPort() {
  for (let i = 0; i < BACKEND_PORT_MAX_ATTEMPTS; i += 1) {
    try {
      return await tryListen(BACKEND_PORT_START + i);
    } catch { /* 端口被占，试下一个 */ }
  }
  // 连续 10 个端口都被占：退回系统分配，功能可用但 origin 会变
  return tryListen(0);
}

// 桌面单机场景：数据落盘到 userData 根目录（与 Chromium 配置同级），仅监听本机回环。
function prepareBackendEnv(port) {
  const dataDir = app.getPath('userData');
  // better-sqlite3 不会自动创建数据库父目录，桌面端在此保证数据目录存在
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.PORT = String(port);
  process.env.HOSTNAME = '127.0.0.1';
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }
  process.env.NOVA_TASK_DB = path.join(dataDir, 'nova-tasks.sqlite');
  process.env.NOVA_IMAGE_DIR = path.join(dataDir, 'nova-images');
  process.env.NOVA_CDP_DIR = path.join(dataDir, 'cdp-products');
  // 桌面单机版默认开启 CDP：Agent 的 browser_* 工具依赖 /api/nova/cdp/*。
  // 未连接时默认允许自动拉起独立调试浏览器；用户可显式设 false 关闭。
  // 安全边界不变：只监听 127.0.0.1，且 authorizeCdpRequest 只放行回环来源。
  // web 部署版（backend/server.js）仍默认关闭，显式置 true 才启用。
  process.env.NOVA_CDP_ENABLED ??= 'true';
  process.env.NOVA_CDP_LAUNCH_ENABLED ??= 'true';
}

// 轮询后端就绪（30 秒超时）
async function waitForBackend(port) {
  const url = `http://127.0.0.1:${port}/api/nova/config`;
  const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`后端返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, BACKEND_READY_POLL_MS));
  }
  throw lastError || new Error('等待后端就绪超时');
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Nova Image Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 页面在备份进行中会注册 beforeunload；浏览器里它会弹确认框，但 Electron 会
  // 静默吞掉关闭动作导致窗口关不掉。这里转成显式确认框，用户始终可以选择强制关闭。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '确认关闭',
      message: '页面正在处理数据，确定要关闭吗？',
      detail: '未完成的导入/导出操作将会中断。',
      buttons: ['仍要关闭', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) {
      // 忽略页面的 beforeunload，放行关闭
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(async () => {
  let port;
  try {
    port = await resolveBackendPort();
    prepareBackendEnv(port);
    installProxiedFetch();
    // require 即自启动（注册路由、WS、定时清理与 shutdown handler）
    require(BACKEND_ENTRY);
    await waitForBackend(port);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('Nova Image Studio 启动失败：', message);
    // showMessageBox 为异步不阻塞事件循环；另设兜底定时强制退出，
    // 避免无窗口管理器等极端环境下进程卡死
    setTimeout(() => app.exit(1), 15000).unref();
    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Nova Image Studio 启动失败',
        message: '内嵌后端未能在 30 秒内就绪',
        detail: message,
        buttons: ['退出'],
      });
    } finally {
      app.exit(1);
    }
    return;
  }

  // Windows/Linux 隐藏默认的英文应用菜单栏；macOS 保留（编辑快捷键依赖应用菜单）
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
