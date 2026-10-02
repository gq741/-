import { BrowserWindow, ipcMain } from 'electron'
import type {
  BannedWord,
  GeneralSettings,
  Intent,
  JevSecretPayload,
  JevTestPayload,
  PlatformId,
  QianniuViewportBounds,
  SecretPayload
} from '@shared/contracts'
import { decideWithJev } from './decision/jevClient'
import {
  getDouyinAdapter,
  getPddAdapter,
  getQianniuAdapter,
  mockAdapter
} from './integration/registry'
import { qianniuCompanion } from './qianniuCompanion'
import {
  chooseQianniuClient,
  findQianniuClient,
  getQianniuClientState,
  recognizeQianniuClient
} from './qianniuClient'
import {
  deleteJevSecret,
  deleteSecret,
  loadJevCredential,
  saveJevSecret,
  saveSecret
} from './secureStorage'

interface IpcContext {
  getWindow(): BrowserWindow | null
  resizeForMode(mode: 'login' | 'workbench'): void
}

async function verifyQianniuTransportPath(): Promise<void> {
  const client = await getQianniuClientState()
  if (client.transportActive && client.transportExecutablePath && !client.transportPathMatches) {
    throw new Error(
      `当前千牛路径与本机传输组件不一致，请先切换到 ${client.transportExecutablePath}`
    )
  }
}

const handlers = [
  'workspace:get-snapshot',
  'workspace:select-rule-platform',
  'workspace:simulate-message',
  'intent:save',
  'intent:delete',
  'banned:save',
  'banned:delete',
  'settings:save',
  'llm:save-secret',
  'llm:delete-secret',
  'jev:save-secret',
  'jev:delete-secret',
  'jev:test',
  'pdd:get-runtime-state',
  'pdd:get-active-orders',
  'pdd:query-active-orders',
  'pdd:set-auto-reply',
  'pdd:resume-all-conversations',
  'pdd:confirm-buyer-receipt',
  'douyin:get-runtime-state',
  'douyin:set-auto-reply',
  'douyin:resume-all-conversations',
  'qianniu:get-client-state',
  'qianniu:find-client',
  'qianniu:get-companion-state',
  'qianniu:recognize',
  'qianniu:set-viewport',
  'qianniu:deactivate-viewport',
  'qianniu:poll-monitor',
  'qianniu:set-auto-reply',
  'qianniu:bind-accounts',
  'qianniu:resume-all-conversations',
  'qianniu:choose-client',
  'window:set-mode'
]

export function registerIpc(context: IpcContext): void {
  for (const channel of handlers) ipcMain.removeHandler(channel)
  ipcMain.handle('workspace:get-snapshot', () => mockAdapter.getSnapshot())
  ipcMain.handle('workspace:select-rule-platform', (_event, platformId: PlatformId) =>
    mockAdapter.selectRulePlatform(platformId)
  )
  ipcMain.handle('workspace:simulate-message', () => mockAdapter.simulateMessage())
  ipcMain.handle('intent:save', (_event, intent: Intent) => mockAdapter.saveIntent(intent))
  ipcMain.handle('intent:delete', (_event, id: string) => mockAdapter.deleteIntent(id))
  ipcMain.handle('banned:save', (_event, item: BannedWord) => mockAdapter.saveBannedWord(item))
  ipcMain.handle('banned:delete', (_event, id: string) => mockAdapter.deleteBannedWord(id))
  ipcMain.handle('settings:save', (_event, settings: GeneralSettings) =>
    mockAdapter.saveSettings(settings)
  )
  ipcMain.handle('llm:save-secret', async (_event, payload: SecretPayload) => {
    const view = await saveSecret(payload)
    mockAdapter.setLlmView(view)
    return view
  })
  ipcMain.handle('llm:delete-secret', async () => {
    const view = await deleteSecret()
    mockAdapter.setLlmView(view)
    return view
  })
  ipcMain.handle('jev:save-secret', async (_event, payload: JevSecretPayload) => {
    const view = await saveJevSecret(payload)
    mockAdapter.setJevView(view)
    return view
  })
  ipcMain.handle('jev:delete-secret', async () => {
    const view = await deleteJevSecret()
    mockAdapter.setJevView(view)
    return view
  })
  ipcMain.handle('jev:test', async (_event, payload: JevTestPayload) => {
    const credential = await loadJevCredential()
    return decideWithJev(credential, {
      message: payload.message,
      orderStatus: 'unknown',
      intents: mockAdapter.getSnapshot().intents
    })
  })
  ipcMain.handle('pdd:get-runtime-state', () => getPddAdapter().getState())
  ipcMain.handle('pdd:get-active-orders', () => getPddAdapter().getActiveBuyerOrders())
  ipcMain.handle('pdd:query-active-orders', () => getPddAdapter().queryActiveBuyerOrders())
  ipcMain.handle('pdd:set-auto-reply', (_event, enabled: boolean) =>
    getPddAdapter().setAutoReply(enabled === true)
  )
  ipcMain.handle('pdd:resume-all-conversations', () => getPddAdapter().resumeAllConversations())
  ipcMain.handle('pdd:confirm-buyer-receipt', (_event, platformMessageId: string) =>
    getPddAdapter().confirmBuyerReceipt(platformMessageId)
  )
  ipcMain.handle('douyin:get-runtime-state', () => getDouyinAdapter().getState())
  ipcMain.handle('douyin:set-auto-reply', (_event, enabled: boolean) =>
    getDouyinAdapter().setAutoReply(enabled === true)
  )
  ipcMain.handle('douyin:resume-all-conversations', () =>
    getDouyinAdapter().resumeAllConversations()
  )
  ipcMain.handle('qianniu:get-client-state', () => getQianniuClientState())
  ipcMain.handle('qianniu:find-client', () => findQianniuClient())
  ipcMain.handle('qianniu:get-companion-state', () => qianniuCompanion.poll())
  ipcMain.handle('qianniu:recognize', async () => {
    const state = await recognizeQianniuClient()
    qianniuCompanion.beginRecognition()
    const companion = await qianniuCompanion.poll()
    if (!companion.loginVisible && !companion.receptionReady) qianniuCompanion.requestReception()
    await getQianniuAdapter().bindAccounts()
    return state
  })
  ipcMain.handle('qianniu:set-viewport', (_event, bounds: QianniuViewportBounds) =>
    qianniuCompanion.setViewport(bounds)
  )
  ipcMain.handle('qianniu:deactivate-viewport', () => qianniuCompanion.deactivate())
  ipcMain.handle('qianniu:poll-monitor', () => getQianniuAdapter().poll())
  ipcMain.handle('qianniu:set-auto-reply', async (_event, enabled: boolean) => {
    if (enabled) await verifyQianniuTransportPath()
    return getQianniuAdapter().setAutoReply(enabled === true)
  })
  ipcMain.handle('qianniu:bind-accounts', async () => {
    await verifyQianniuTransportPath()
    return getQianniuAdapter().bindAccounts()
  })
  ipcMain.handle('qianniu:resume-all-conversations', () =>
    getQianniuAdapter().resumeAllConversations()
  )
  ipcMain.handle('qianniu:choose-client', () => chooseQianniuClient(context.getWindow()))
  ipcMain.handle('window:set-mode', (_event, mode: 'login' | 'workbench') =>
    context.resizeForMode(mode)
  )

  ipcMain.removeAllListeners('window:minimize')
  ipcMain.removeAllListeners('window:toggle-maximize')
  ipcMain.removeAllListeners('window:close')
  ipcMain.on('window:minimize', () => context.getWindow()?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    const window = context.getWindow()
    if (!window) return
    window.isMaximized() ? window.unmaximize() : window.maximize()
  })
  ipcMain.on('window:close', () => context.getWindow()?.close())
}
