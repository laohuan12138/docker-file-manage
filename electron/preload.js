'use strict';
/** 预加载脚本：只暴露少量只读信息给页面，保持上下文隔离 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dockfile', {
  desktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  onDownloaded: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('dockfile:downloaded', (_e, file) => cb(file));
  },
});
