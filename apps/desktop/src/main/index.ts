import { app, BrowserWindow } from 'electron'

import { registerDesktopIpc } from './ipc'
import { resolveWebDistRoot } from './paths'
import { createMainWindow } from './window'
import { startEmbeddedWebServer, type EmbeddedWebServer } from './web-server'

let mainWindow: BrowserWindow | null = null
let embeddedServer: EmbeddedWebServer | null = null

const isDev = !app.isPackaged

function configureChromium() {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
}

async function resolveAppUrl() {
  if (isDev) {
    return __WEB_DEV_URL__
  }

  const webDistRoot = resolveWebDistRoot()
  embeddedServer = await startEmbeddedWebServer(webDistRoot)
  return embeddedServer.url
}

async function createApp() {
  const loadUrl = await resolveAppUrl()
  registerDesktopIpc(() => mainWindow)
  mainWindow = createMainWindow(loadUrl)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupSingleInstance() {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  return true
}

configureChromium()

if (setupSingleInstance()) {
  app.whenReady().then(() => {
    void createApp()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createApp()
    }
  })

  app.on('before-quit', () => {
    void embeddedServer?.close()
  })
}
