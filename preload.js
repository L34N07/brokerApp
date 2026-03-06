const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apiBroker', {
  checkToken: (payload) => ipcRenderer.invoke('broker:check-token', payload),
  getPortfolio: (payload) => ipcRenderer.invoke('broker:get-portfolio', payload),
  getAccountStatus: (payload) => ipcRenderer.invoke('broker:get-account-status', payload),
  getOperations: (filters) => ipcRenderer.invoke('broker:get-operations', filters),
  openOperationsWindow: () => ipcRenderer.invoke('broker:open-operations-window'),
  openLoginWindow: () => ipcRenderer.invoke('broker:open-login-window'),
  logout: () => ipcRenderer.invoke('broker:logout'),
  activateSession: () => ipcRenderer.invoke('broker:activate-session'),
  listAccounts: () => ipcRenderer.invoke('broker:list-accounts'),
  login: (payload) => ipcRenderer.invoke('broker:login', payload),
  selectAccount: (payload) => ipcRenderer.invoke('broker:select-account', payload),
  deleteAccount: (payload) => ipcRenderer.invoke('broker:delete-account', payload)
});
