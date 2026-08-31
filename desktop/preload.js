'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reseed', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  clearSession: (partition) => ipcRenderer.invoke('session:clear', partition),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),

  // The real-Chrome session used for YouTube.
  chrome: {
    status: () => ipcRenderer.invoke('chrome:status'),
    signIn: (startUrl) => ipcRenderer.invoke('chrome:signin', startUrl),
    launch: (startUrl) => ipcRenderer.invoke('chrome:launch', startUrl),
    navigate: (url) => ipcRenderer.invoke('chrome:navigate', url),
    evaluate: (code, userGesture) =>
      ipcRenderer.invoke('chrome:evaluate', { code, userGesture }),
    url: () => ipcRenderer.invoke('chrome:url'),
    wipe: () => ipcRenderer.invoke('chrome:wipe')
  }
});
