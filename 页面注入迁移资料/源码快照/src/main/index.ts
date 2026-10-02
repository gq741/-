import { app, BrowserWindow, Menu, screen, session, Tray } from 'electron'
import { join, resolve } from 'path'
import { writeFile } from 'fs/promises'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { qianniuCompanion } from './qianniuCompanion'
import { loadJevSecretView, loadSecretView } from './secureStorage'
import {
  getDouyinAdapter,
  getPddAdapter,
  getQianniuAdapter,
  initializeDouyinAdapter,
  initializePddAdapter,
  initializeQianniuAdapter,
  mockAdapter
} from './integration/registry'
import { ENABLE_PLATFORM_WEBVIEW, PLATFORM_HOST_ALLOWLIST } from './integration/flags'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let appIsQuitting = false
let qianniuPollTimer: ReturnType<typeof setInterval> | undefined

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  tray = new Tray(icon)
  tray.setToolTip('云值守 · 客服值守台')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开云值守', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出云值守',
        click: () => {
          appIsQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

function workbenchBounds(): { width: number; height: number } {
  const { width: availableWidth, height: availableHeight } = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1440, Math.floor(availableWidth * 0.9))
  const height = Math.min(900, Math.floor(availableHeight * 0.9))
  return {
    width: availableWidth >= 1080 ? Math.max(1080, width) : Math.floor(availableWidth * 0.95),
    height: availableHeight >= 680 ? Math.max(680, height) : Math.floor(availableHeight * 0.95)
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 780,
    height: 595,
    minWidth: 720,
    minHeight: 540,
    show: false,
    frame: process.env['QA_FRAME'] === 'true',
    backgroundColor: '#F5F6F8',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: ENABLE_PLATFORM_WEBVIEW,
      backgroundThrottling: false
    }
  })

  window.on('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (appIsQuitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    let allowed = ENABLE_PLATFORM_WEBVIEW
    try {
      const url = new URL(params.src)
      allowed &&= url.protocol === 'https:' && PLATFORM_HOST_ALLOWLIST.has(url.hostname)
      allowed &&=
        params.partition.startsWith('persist:pdd-') ||
        params.partition.startsWith('persist:douyin-')
    } catch {
      allowed = false
    }
    if (!allowed) {
      event.preventDefault()
      return
    }
    const storeSession = session.fromPartition(params.partition)
    storeSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.backgroundThrottling = false
    webPreferences.session = storeSession
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('will-navigate', (event, url) => {
      try {
        const target = new URL(url)
        const pdd = guest.session !== session.fromPartition('persist:douyin-store-default')
        const hostname = target.hostname
        const allowed =
          target.protocol === 'https:' &&
          (pdd
            ? hostname === 'pinduoduo.com' || hostname.endsWith('.pinduoduo.com')
            : hostname === 'jinritemai.com' ||
              hostname.endsWith('.jinritemai.com') ||
              hostname === 'douyin.com' ||
              hostname.endsWith('.douyin.com'))
        if (!allowed) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    })
    if (guest.session === session.fromPartition('persist:douyin-store-default')) {
      void getDouyinAdapter().attach(guest)
    } else {
      void getPddAdapter().attach(guest)
    }
  })
  window.webContents.session.on('will-download', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && developmentUrl && url.startsWith(developmentUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const relocatedUserData = process.env['YUNZHISHOU_USER_DATA']
if (relocatedUserData) app.setPath('userData', resolve(relocatedUserData))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.local.ai-customer-care-desk')
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    mockAdapter.loadRules(join(app.getPath('userData'), 'rules', 'rules-state.json'))
    mockAdapter.setLlmView(await loadSecretView())
    mockAdapter.setJevView(await loadJevSecretView())
    initializePddAdapter(join(app.getPath('userData'), 'pdd', 'runtime-state.json'))
    initializeDouyinAdapter(join(app.getPath('userData'), 'douyin', 'runtime-state.json'))
    initializeQianniuAdapter(join(app.getPath('userData'), 'qianniu', 'runtime-state.json'))
    qianniuPollTimer = setInterval(() => void getQianniuAdapter().poll(), 5000)
    mainWindow = createWindow()
    qianniuCompanion.bindWindow(mainWindow)
    createTray()
    registerIpc({
      getWindow: () => mainWindow,
      resizeForMode: (mode) => {
        if (!mainWindow) return
        if (mode === 'login') {
          mainWindow.setMinimumSize(720, 540)
          mainWindow.setSize(780, 595, true)
        } else {
          const bounds = workbenchBounds()
          mainWindow.setMinimumSize(Math.min(1080, bounds.width), Math.min(680, bounds.height))
          mainWindow.setSize(bounds.width, bounds.height, true)
        }
        mainWindow.center()
      }
    })

    const qaScreenshotPath = process.env['QA_SCREENSHOT_PATH']
    if (qaScreenshotPath) {
      mainWindow.webContents.once('did-finish-load', async () => {
        const route = process.env['QA_ROUTE'] ?? '/login'
        if (route !== '/login') {
          const bounds = workbenchBounds()
          mainWindow?.setMinimumSize(Math.min(1080, bounds.width), Math.min(680, bounds.height))
          mainWindow?.setSize(bounds.width, bounds.height)
          mainWindow?.center()
          await mainWindow?.webContents.executeJavaScript(
            `location.hash = ${JSON.stringify(route)}`
          )
        }
        const screenshotDelay = Number(process.env['QA_SCREENSHOT_DELAY_MS'] ?? 1400)
        await new Promise((resolve) => setTimeout(resolve, screenshotDelay))
        const image = await mainWindow?.webContents.capturePage()
        if (image) await writeFile(qaScreenshotPath, image.toPNG())
        if (process.env['QA_EXIT'] === 'true') app.quit()
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appIsQuitting = true
  qianniuCompanion.stop()
  if (qianniuPollTimer) clearInterval(qianniuPollTimer)
})
