'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('omni', {
  // Electron 32+ removed File.path; this is the supported replacement.
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
  info: () => ipcRenderer.invoke('app:info'),
  openFiles: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  extractDepth: (p) => ipcRenderer.invoke('depth:extract', p),
  listLanguages: () => ipcRenderer.invoke('lang:list'),
  installLanguage: (code) => ipcRenderer.invoke('lang:install', code),
  harness: {
    args: () => ipcRenderer.invoke('harness:args'),
    log: (line) => ipcRenderer.send('harness:log', line),
    done: (payload) => ipcRenderer.send('harness:done', payload),
  },
});
