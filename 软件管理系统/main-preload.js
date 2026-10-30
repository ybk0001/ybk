const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  context: () => ipcRenderer.invoke('desktop:context'),
  openTaxReference: id => ipcRenderer.invoke('desktop:open-tax-reference', id),
  chooseArchiveDirectory: () => ipcRenderer.invoke('desktop:choose-archive-directory')
});
