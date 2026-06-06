import path from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron'

import {
  disposeDesktopAutoUpdate,
  initializeDesktopAutoUpdate,
} from './auto-update'
import { registerDesktopIpc } from './ipc'
import { disposeHotkeys } from './hotkeys'
import { resolveWebDistRoot } from './paths'
import { createMainWindow } from './window'
import { startEmbeddedWebServer, type EmbeddedWebServer } from './web-server'
import {
  DEFAULT_DESKTOP_PREFERENCES,
  loadDesktopPreferences,
  saveDesktopPreferences,
  type DesktopPreferences,
} from './desktop-preferences'
import { desktopSessionPath } from './desktop-session'
import { routeFromDeepLink } from './deep-links'
import { applyLoginItemSettings } from './login-item'

let mainWindow: BrowserWindow | null = null
let embeddedServer: EmbeddedWebServer | null = null
let tray: Tray | null = null
let quitting = false
let desktopIpcRegistered = false
let desktopPreferences: DesktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES }
let creatingApp: Promise<void> | null = null

const isDev = !app.isPackaged
const trayIconDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANklEQVR4nGP4//8/AyUYlwQuQJQBhABeA4gFWA0gFaAYQC4YNYCaBlAcjVRJSFRJylTJTCRhAJIsmJKjYcDEAAAAAElFTkSuQmCC'

function configureChromium() {
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
    return
  }

  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('ignore-gpu-blocklist')
    app.commandLine.appendSwitch(
      'enable-features',
      'MediaFoundationH264CbpEncoding,MediaFoundationVP9Encoding',
    )
  }
}

async function resolveAppUrl() {
  if (isDev) {
    return __WEB_DEV_URL__
  }

  if (embeddedServer) return embeddedServer.url

  const webDistRoot = resolveWebDistRoot()
  embeddedServer = await startEmbeddedWebServer(webDistRoot)
  return embeddedServer.url
}

function desktopPreferencesPath() {
  return path.join(app.getPath('userData'), 'desktop-preferences.json')
}

function currentDesktopSessionPath() {
  return desktopSessionPath(app.getPath('userData'))
}

function getDesktopPreferences() {
  return desktopPreferences
}

async function setCloseToTray(closeToTray: boolean) {
  const nextPreferences = { ...desktopPreferences, closeToTray }
  await saveDesktopPreferences(desktopPreferencesPath(), nextPreferences)
  desktopPreferences = nextPreferences
  updateTrayMenu()
  return desktopPreferences
}

async function setOpenAtLogin(openAtLogin: boolean) {
  const nextPreferences = { ...desktopPreferences, openAtLogin }
  await saveDesktopPreferences(desktopPreferencesPath(), nextPreferences)
  desktopPreferences = nextPreferences
  applyLoginItemSettings(openAtLogin)
  return desktopPreferences
}

async function ensureAppCreated() {
  if (mainWindow && !mainWindow.isDestroyed()) return
  if (creatingApp) {
    await creatingApp
    return
  }

  creatingApp = createApp()
  try {
    await creatingApp
  } finally {
    creatingApp = null
  }
}

function reportStartupFailure(error: unknown) {
  console.error('[desktop] failed to start', error)
  const message =
    error instanceof Error ? error.message : 'Не удалось запустить syrnike13.'
  dialog.showErrorBox('syrnike13', message)
  quitting = true
  app.quit()
}

function showMainWindow() {
  if (!mainWindow) {
    void ensureAppCreated()
      .then(() => {
        if (!mainWindow) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      })
      .catch(reportStartupFailure)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function navigateToDeepLink(route: string) {
  await ensureAppCreated()
  showMainWindow()
  if (!mainWindow) return
  const appUrl = await resolveAppUrl()
  await mainWindow.loadURL(new URL(route, appUrl).toString())
}

function quitApp() {
  quitting = true
  app.quit()
}

function trayIcon() {
  const icon = nativeImage.createFromDataURL(trayIconDataUrl)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  return icon
}

function updateTrayMenu() {
  if (!tray) return

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Открыть syrnike13',
      click: showMainWindow,
    },
    {
      label: 'Скрыть окно',
      enabled: Boolean(mainWindow?.isVisible()),
      click: () => mainWindow?.hide(),
    },
    { type: 'separator' },
    {
      label: 'Закрывать в трей',
      type: 'checkbox',
      checked: desktopPreferences.closeToTray,
      click: (item) => {
        void setCloseToTray(item.checked).catch((error) => {
          console.error('[desktop] failed to save tray preference', error)
          updateTrayMenu()
        })
      },
    },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: quitApp,
    },
  ]

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function setupTray() {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip('syrnike13')
  tray.on('click', showMainWindow)
  updateTrayMenu()
}

async function createApp() {
  const loadUrl = await resolveAppUrl()
  if (!desktopIpcRegistered) {
    desktopIpcRegistered = true
    registerDesktopIpc(() => mainWindow, {
      getWindowPreferences: getDesktopPreferences,
      setCloseToTray,
      setOpenAtLogin,
      showWindow: showMainWindow,
      sessionPath: currentDesktopSessionPath(),
    })
  }
  mainWindow = createMainWindow(loadUrl)
  mainWindow.on('close', (event) => {
    if (quitting || !desktopPreferences.closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
    updateTrayMenu()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    updateTrayMenu()
  })
  mainWindow.on('show', updateTrayMenu)
  mainWindow.on('hide', updateTrayMenu)
  mainWindow.on('minimize', updateTrayMenu)
  mainWindow.on('restore', updateTrayMenu)
  mainWindow.once('ready-to-show', () => {
    setupTray()
    initializeDesktopAutoUpdate(() => mainWindow)
  })
}

function setupSingleInstance() {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }

  app.on('second-instance', (_event, argv) => {
    const route = argv.map(routeFromDeepLink).find((value) => value !== null)
    if (route) void navigateToDeepLink(route).catch(reportStartupFailure)
    else showMainWindow()
  })

  return true
}

configureChromium()

if (setupSingleInstance()) {
  const initialDeepLinkRoute = process.argv
    .map(routeFromDeepLink)
    .find((value) => value !== null)

  if (app.isPackaged) {
    app.setAsDefaultProtocolClient('syrnike13')
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    const route = routeFromDeepLink(url)
    if (!route) return
    void navigateToDeepLink(route).catch(reportStartupFailure)
  })

  app.whenReady().then(async () => {
    desktopPreferences = await loadDesktopPreferences(desktopPreferencesPath())
    applyLoginItemSettings(desktopPreferences.openAtLogin)
    if (initialDeepLinkRoute) {
      void navigateToDeepLink(initialDeepLinkRoute).catch(reportStartupFailure)
    } else {
      void ensureAppCreated().catch(reportStartupFailure)
    }
  })

  app.on('window-all-closed', () => {
    if (desktopPreferences.closeToTray && !quitting) return
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void ensureAppCreated().catch(reportStartupFailure)
    }
  })

  app.on('before-quit', () => {
    quitting = true
    disposeDesktopAutoUpdate()
    disposeHotkeys()
    tray?.destroy()
    tray = null
    void embeddedServer?.close()
  })
}
