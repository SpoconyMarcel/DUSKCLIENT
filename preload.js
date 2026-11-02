const { contextBridge, ipcRenderer } = require('electron');
const on = (c, f) => ipcRenderer.on(c, (_, v) => f(v));
contextBridge.exposeInMainWorld('api', {
  restore: () => ipcRenderer.invoke('restore'),
  login: () => ipcRenderer.invoke('login'),
  play: o => ipcRenderer.invoke('play', o),
  onStatus: f => on('status', f),
  onProgress: f => on('progress', f),
  onClosed: f => on('closed', f),
});
