import { app, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

import { IPC, type DesktopUpdateState } from '@syrnike13/platform'
import { DESKTOP_RELEASE_METADATA } from './desktop-app-identity'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 10_000

let currentState: DesktopUpdateState = { status: 'idle' }
let getWindowRef: (() => BrowserWindow | null) | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
let started = false
let inFlightUpdateCheck: Promise<DesktopUpdateState> | null = null

function broadcastState() {
  const win = getWindowRef?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.updatesStateChanged, currentState)
}

function setState(state: DesktopUpdateState) {
  currentState = state
  broadcastState()
}

export function getDesktopUpdateState() {
  return currentState
}

export async function checkForDesktopUpdates() {
  if (!DESKTOP_RELEASE_METADATA.autoUpdateEnabled) return currentState
  if (!app.isPackaged) return currentState
  if (inFlightUpdateCheck) return inFlightUpdateCheck

  inFlightUpdateCheck = (async () => {
    setState({ status: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Не удалось проверить обновления',
      })
    }

    return currentState
  })()

  try {
    return await inFlightUpdateCheck
  } finally {
    inFlightUpdateCheck = null
  }
}

export function quitAndInstallDesktopUpdate() {
  if (!DESKTOP_RELEASE_METADATA.autoUpdateEnabled) return
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall()
}

export function initializeDesktopAutoUpdate(getWindow: () => BrowserWindow | null) {
  if (!DESKTOP_RELEASE_METADATA.autoUpdateEnabled) return
  if (!app.isPackaged || started) return
  started = true
  getWindowRef = getWindow

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ status: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      percent: progress.percent,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info.version })
  })

  autoUpdater.on('error', (error) => {
    console.error('[desktop] auto-update error', error)
    setState({
      status: 'error',
      message: error.message,
    })
  })

  setTimeout(() => {
    void checkForDesktopUpdates()
  }, INITIAL_CHECK_DELAY_MS)

  checkTimer = setInterval(() => {
    void checkForDesktopUpdates()
  }, CHECK_INTERVAL_MS)
}

export function disposeDesktopAutoUpdate() {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}
