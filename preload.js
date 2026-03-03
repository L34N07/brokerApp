const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apiBroker', {
  checkToken: () => ipcRenderer.invoke('broker:check-token'),
  getPortfolio: () => ipcRenderer.invoke('broker:get-portfolio')
});
