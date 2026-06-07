import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type ActivityDetails,
  type DesktopStoredSession,
  type DesktopWindowPreferences,
  type HotkeyBinding,
} from '@syrnike13/platform'

import {
  checkForDesktopUpdates,
  getDesktopUpdateState,
  quitAndInstallDesktopUpdate,
} from './auto-update'
import {
  getHotkeyBindings,
  getHotkeyRuntimeStatus,
  initializeHotkeys,
  setHotkeyBindings,
  setHotkeysSuspended,
  startHotkeyRecording,
  stopHotkeyRecording,
} from './hotkeys'
import {
  clearDesktopSession,
  loadDesktopSession,
  saveDesktopSession,
} from './desktop-session'
import { registerDisplayMediaIpc } from './media-permissions'
import {
  connectMediaEngineRoom,
  disconnectMediaEngineRoom,
  getMediaEngineRuntimeStatus,
  initializeMediaEngine,
  micSetEnabledMediaEngine,
  pingMediaEngine,
  publishMediaEngineTestTone,
  startMediaEngineScreen,
  stopMediaEngineScreen,
} from './media-engine'
import { registerMediaEnginePickerIpc } from './media-engine-picker'

let lastActivity: ActivityDetails | null = null

export function registerDesktopIpc(
  getWindow: () => BrowserWindow | null,
  options: {
    getWindowPreferences: () => DesktopWindowPreferences
    setCloseToTray: (closeToTray: boolean) => Promise<DesktopWindowPreferences>
    setOpenAtLogin: (openAtLogin: boolean) => Promise<DesktopWindowPreferences>
    showWindow: () => void
    sessionPath: string
  },
) {
  initializeHotkeys(getWindow)
  initializeMediaEngine(getWindow)
  registerMediaEnginePickerIpc(getWindow)
  registerDisplayMediaIpc(getWindow)

  ipcMain.handle(IPC.versions, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))

  ipcMain.on(IPC.windowMinimize, () => {
    getWindow()?.minimize()
  })

  ipcMain.on(IPC.windowMaximize, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(IPC.windowClose, () => {
    getWindow()?.close()
  })

  ipcMain.on(IPC.windowShow, () => {
    options.showWindow()
  })

  ipcMain.handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)

  ipcMain.handle(IPC.windowGetPreferences, () => options.getWindowPreferences())

  ipcMain.handle(IPC.windowSetCloseToTray, (_event, closeToTray: boolean) =>
    options.setCloseToTray(Boolean(closeToTray)),
  )

  ipcMain.handle(IPC.windowSetOpenAtLogin, (_event, openAtLogin: boolean) =>
    options.setOpenAtLogin(Boolean(openAtLogin)),
  )

  ipcMain.handle(IPC.updatesGetState, () => getDesktopUpdateState())

  ipcMain.handle(IPC.updatesCheck, () => checkForDesktopUpdates())

  ipcMain.on(IPC.updatesInstall, () => {
    quitAndInstallDesktopUpdate()
  })

  ipcMain.handle(IPC.activitySet, (_event, details: ActivityDetails | null) => {
    lastActivity = details
    // TODO: Discord RPC / macOS Now Playing — подключить нативный модуль.
    if (details) {
      console.info('[desktop] activity set', details)
    } else {
      console.info('[desktop] activity cleared')
    }
  })

  ipcMain.handle(IPC.activityClear, () => {
    lastActivity = null
    console.info('[desktop] activity cleared')
  })

  ipcMain.handle(IPC.authLoadSession, () =>
    loadDesktopSession(options.sessionPath),
  )

  ipcMain.handle(IPC.authSaveSession, (_event, session: DesktopStoredSession) =>
    saveDesktopSession(options.sessionPath, session),
  )

  ipcMain.handle(IPC.authClearSession, () =>
    clearDesktopSession(options.sessionPath),
  )

  ipcMain.handle(IPC.hotkeysGetBindings, () => getHotkeyBindings())

  ipcMain.handle(IPC.hotkeysSetBindings, (_event, bindings: HotkeyBinding[]) =>
    setHotkeyBindings(bindings),
  )

  ipcMain.handle(IPC.hotkeysSetSuspended, (_event, suspended: boolean) => {
    setHotkeysSuspended(Boolean(suspended))
  })

  ipcMain.handle(IPC.hotkeysStartRecording, () => {
    startHotkeyRecording()
  })

  ipcMain.handle(IPC.hotkeysStopRecording, () => {
    stopHotkeyRecording()
  })

  ipcMain.handle(IPC.hotkeysGetRuntimeStatus, () => getHotkeyRuntimeStatus())

  ipcMain.handle(IPC.mediaEnginePing, () => pingMediaEngine())

  ipcMain.handle(IPC.mediaEngineGetStatus, () => getMediaEngineRuntimeStatus())

  ipcMain.handle(IPC.mediaEngineRoomConnect, (_event, params) =>
    connectMediaEngineRoom(params),
  )

  ipcMain.handle(IPC.mediaEngineRoomDisconnect, () =>
    disconnectMediaEngineRoom(),
  )

  ipcMain.handle(IPC.mediaEnginePublishTestTone, () =>
    publishMediaEngineTestTone(),
  )

  ipcMain.handle(IPC.mediaEngineMicSetEnabled, (_event, enabled: boolean) =>
    micSetEnabledMediaEngine(enabled),
  )

  ipcMain.handle(IPC.mediaEngineScreenStart, (_event, params) =>
    startMediaEngineScreen(getWindow, params),
  )

  ipcMain.handle(IPC.mediaEngineScreenStop, () => stopMediaEngineScreen())

  return () => {
    lastActivity = null
  }
}

export function getLastActivity() {
  return lastActivity
}
