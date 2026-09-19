// 桌面壳 preload：只向渲染进程暴露版本信息，不开放任何 Node 能力
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('novaDesktop', {
  versions: process.versions,
});
