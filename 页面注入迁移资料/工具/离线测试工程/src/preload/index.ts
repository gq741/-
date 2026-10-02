import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '@shared/contracts'

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('workspace:get-snapshot'),
  selectRulePlatform: (platformId) =>
    ipcRenderer.invoke('workspace:select-rule-platform', platformId),
  simulateMessage: () => ipcRenderer.invoke('workspace:simulate-message'),
  saveIntent: (intent) => ipcRenderer.invoke('intent:save', intent),
  deleteIntent: (id) => ipcRenderer.invoke('intent:delete', id),
  saveBannedWord: (item) => ipcRenderer.invoke('banned:save', item),
  deleteBannedWord: (id) => ipcRenderer.invoke('banned:delete', id),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveLlmSecret: (payload) => ipcRenderer.invoke('llm:save-secret', payload),
  deleteLlmSecret: () => ipcRenderer.invoke('llm:delete-secret'),
  saveJevSecret: (payload) => ipcRenderer.invoke('jev:save-secret', payload),
  deleteJevSecret: () => ipcRenderer.invoke('jev:delete-secret'),
  testJev: (payload) => ipcRenderer.invoke('jev:test', payload),
  getPddRuntimeState: () => ipcRenderer.invoke('pdd:get-runtime-state'),
  getPddActiveOrders: () => ipcRenderer.invoke('pdd:get-active-orders'),
  queryPddActiveOrders: () => ipcRenderer.invoke('pdd:query-active-orders'),
  setPddAutoReply: (enabled) => ipcRenderer.invoke('pdd:set-auto-reply', enabled),
  getDouyinRuntimeState: () => ipcRenderer.invoke('douyin:get-runtime-state'),
  getQianniuClientState: () => ipcRenderer.invoke('qianniu:get-client-state'),
  findQianniuClient: () => ipcRenderer.invoke('qianniu:find-client'),
  getQianniuCompanionState: () => ipcRenderer.invoke('qianniu:get-companion-state'),
  recognizeQianniu: () => ipcRenderer.invoke('qianniu:recognize'),
  setQianniuViewport: (bounds) => ipcRenderer.invoke('qianniu:set-viewport', bounds),
  deactivateQianniuViewport: () => ipcRenderer.invoke('qianniu:deactivate-viewport'),
  pollQianniuMonitor: () => ipcRenderer.invoke('qianniu:poll-monitor'),
  setQianniuAutoReply: (enabled) => ipcRenderer.invoke('qianniu:set-auto-reply', enabled),
  bindQianniuAccounts: () => ipcRenderer.invoke('qianniu:bind-accounts'),
  resumeAllQianniuConversations: () => ipcRenderer.invoke('qianniu:resume-all-conversations'),
  chooseQianniuClient: () => ipcRenderer.invoke('qianniu:choose-client'),
  setDouyinAutoReply: (enabled) => ipcRenderer.invoke('douyin:set-auto-reply', enabled),
  resumeAllDouyinConversations: () => ipcRenderer.invoke('douyin:resume-all-conversations'),
  resumeAllPddConversations: () => ipcRenderer.invoke('pdd:resume-all-conversations'),
  confirmPddBuyerReceipt: (platformMessageId) =>
    ipcRenderer.invoke('pdd:confirm-buyer-receipt', platformMessageId),
  setWindowMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close')
}

contextBridge.exposeInMainWorld('api', api)
