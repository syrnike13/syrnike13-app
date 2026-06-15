import { app, clipboard, ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type ActivityDetails,
  type DesktopLocalSettings,
  type DesktopOverlaySnapshot,
  type DesktopLocalSettingsPatch,
  type DesktopStoredSession,
  type DesktopTrayVoiceState,
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
import { registerDesktopMusicPresenceIpc } from './desktop-music-presence-service'
import {
  desktopLocalSettingsDefaults,
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from './desktop-local-settings'
import { registerNativeMediaEngineIpc } from './native-media-engine'
import { registerDisplayMediaIpc } from './media-permissions'
import {
  canSetDesktopOverlaySnapshot,
  canUseDesktopOverlaySender,
  getDesktopOverlayState,
  setDesktopOverlayEnabled,
  setDesktopOverlaySettings,
  setDesktopOverlaySnapshot,
} from './overlay-manager'

let lastActivity: ActivityDetails | null = null

export function registerDesktopIpc(
  getWindow: () => BrowserWindow | null,
  options: {
    getWindowPreferences: () => DesktopWindowPreferences
    setCloseToTray: (closeToTray: boolean) => Promise<DesktopWindowPreferences>
    setOpenAtLogin: (openAtLogin: boolean) => Promise<DesktopWindowPreferences>
    setTrayVoiceState: (state: DesktopTrayVoiceState) => void
    onLocalSettingsUpdated?: (settings: DesktopLocalSettings) => void
    getLocalSettings?: () => DesktopLocalSettings
    showWindow: () => void
    localSettingsPath: string
    localSettingsDefaults?: ReturnType<typeof desktopLocalSettingsDefaults>
    sessionPath: string
  },
) {
  initializeHotkeys(getWindow)
  registerDisplayMediaIpc(getWindow)
  registerNativeMediaEngineIpc(getWindow)
  const disposeMusicPresenceIpc = registerDesktopMusicPresenceIpc(getWindow, {
    getSettings:
      options.getLocalSettings ??
      (() =>
        options.localSettingsDefaults ??
        desktopLocalSettingsDefaults()),
  })

  ipcMain.handle(IPC.versions, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))

  ipcMain.handle(IPC.clipboardWriteText, (_event, text: string) => {
    if (typeof text !== 'string') {
      throw new Error('Clipboard text must be a string')
    }
    clipboard.writeText(text)
  })

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

  ipcMain.handle(IPC.traySetVoiceState, (_event, state: DesktopTrayVoiceState) => {
    options.setTrayVoiceState(state)
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

  ipcMain.handle(IPC.settingsLoad, () =>
    loadDesktopLocalSettings(
      options.localSettingsPath,
      options.localSettingsDefaults,
    ),
  )

  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: DesktopLocalSettingsPatch) => {
    const settings = await updateDesktopLocalSettings(
      options.localSettingsPath,
      patch,
      options.localSettingsDefaults,
    )
    setDesktopOverlaySettings(settings.overlay)
    options.onLocalSettingsUpdated?.(settings)
    return settings
  })

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

  ipcMain.handle(IPC.overlayGetState, (event) => {
    if (!canUseDesktopOverlaySender(event.sender)) {
      throw new Error('Untrusted overlay state request')
    }
    return getDesktopOverlayState()
  })

  ipcMain.handle(IPC.overlaySetEnabled, (event, enabled: boolean) => {
    if (!canSetDesktopOverlaySnapshot(event.sender)) {
      throw new Error('Untrusted overlay settings request')
    }
    return setDesktopOverlayEnabled(Boolean(enabled))
  })

  ipcMain.handle(
    IPC.overlaySetSnapshot,
    (event, snapshot: DesktopOverlaySnapshot) => {
      if (!canSetDesktopOverlaySnapshot(event.sender)) {
        throw new Error('Untrusted overlay snapshot request')
      }
      return setDesktopOverlaySnapshot(snapshot)
    },
  )

  return () => {
    lastActivity = null
    disposeMusicPresenceIpc()
  }
}

export function getLastActivity() {
  return lastActivity
}
