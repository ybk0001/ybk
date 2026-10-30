const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nasSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: value => ipcRenderer.invoke('settings:save', value),
  decode: code => ipcRenderer.invoke('settings:decode', code),
  chooseDirectory: () => ipcRenderer.invoke('settings:choose-directory'),
  firewall: port => ipcRenderer.invoke('settings:firewall', port)
});
