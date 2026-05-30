const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apiBroker', {
  checkToken: (payload) => ipcRenderer.invoke('broker:check-token', payload),
  getPortfolio: (payload) => ipcRenderer.invoke('broker:get-portfolio', payload),
  getAccountStatus: (payload) => ipcRenderer.invoke('broker:get-account-status', payload),
  getSymbolSearchConfig: (payload) => ipcRenderer.invoke('broker:get-symbol-search-config', payload),
  getSymbols: (payload) => ipcRenderer.invoke('broker:get-symbols', payload),
  getOperations: (filters) => ipcRenderer.invoke('broker:get-operations', filters),
  getQuoteFlags: (payload) => ipcRenderer.invoke('broker:get-quote-flags', payload),
  sellOrder: (payload) => ipcRenderer.invoke('broker:sell-order', payload),
  buyOrder: (payload) => ipcRenderer.invoke('broker:buy-order', payload),
  cancelOperation: (payload) => ipcRenderer.invoke('broker:cancel-operation', payload),
  saveDashboardLayout: (payload) => ipcRenderer.invoke('broker:save-dashboard-layout', payload),
  loadDashboardLayout: (payload) => ipcRenderer.invoke('broker:load-dashboard-layout', payload),
  listDashboardLayouts: (payload) => ipcRenderer.invoke('broker:list-dashboard-layouts', payload),
  deleteDashboardLayout: (payload) => ipcRenderer.invoke('broker:delete-dashboard-layout', payload),
  openOperationsWindow: () => ipcRenderer.invoke('broker:open-operations-window'),
  openSymbolsWindow: () => ipcRenderer.invoke('broker:open-symbols-window'),
  openDashboardWindow: () => ipcRenderer.invoke('broker:open-dashboard-window'),
  logout: () => ipcRenderer.invoke('broker:logout'),
  activateSession: () => ipcRenderer.invoke('broker:activate-session'),
  listAccounts: () => ipcRenderer.invoke('broker:list-accounts'),
  login: (payload) => ipcRenderer.invoke('broker:login', payload),
  selectAccount: (payload) => ipcRenderer.invoke('broker:select-account', payload),
  deleteAccount: (payload) => ipcRenderer.invoke('broker:delete-account', payload)
});
