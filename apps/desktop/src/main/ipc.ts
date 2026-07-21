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
  isVoiceCommand,
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
import {
  desktopLocalSettingsDefaults,
  loadDesktopLocalSettings,
} from './desktop-local-settings'
import {
  flushNativeMediaDiagnostics,
  registerNativeMediaRuntimeIpc,
} from './native-media-engine'
import { registerDisplayMediaIpc } from './media-permissions'
import {
  canSetDesktopOverlaySnapshot,
  canUseDesktopOverlaySender,
  getDesktopOverlayState,
  setDesktopOverlayEnabled,
  setDesktopOverlaySettings,
  setDesktopOverlaySnapshot,
} from './overlay-manager'
import {
  broadcastDesktopVoiceSnapshot,
  desktopVoiceService,
} from './voice/desktop-voice-service'
import { createDesktopDiagnosticBundle } from './diagnostic-bundle'
import {
  acknowledgeNativeDiagnosticIncidents,
  captureRendererDiagnosticIncidentForAccount,
  configureNativeDiagnosticIncidentAccount,
  leaseNativeDiagnosticIncidents,
  releaseNativeDiagnosticIncidents,
} from './native-runtime/diagnostic-incidents'

let lastActivity: ActivityDetails | null = null

export function registerDesktopIpc(
  getWindow: () => BrowserWindow | null,
  options: {
    getWindowPreferences: () => DesktopWindowPreferences
    setCloseToTray: (closeToTray: boolean) => Promise<DesktopWindowPreferences>
    setOpenAtLogin: (openAtLogin: boolean) => Promise<DesktopWindowPreferences>
    setTrayVoiceState: (state: DesktopTrayVoiceState) => void
    updateLocalSettings: (
      patch: DesktopLocalSettingsPatch,
    ) => Promise<DesktopLocalSettings>
    showWindow: () => void
    localSettingsPath: string
    localSettingsDefaults?: ReturnType<typeof desktopLocalSettingsDefaults>
    sessionPath: string
  },
) {
  let authSessionRevision = 0
  let authPersistenceTail = Promise.resolve()
  const applyAuthenticatedSession = (session: DesktopStoredSession | null) => {
    configureNativeDiagnosticIncidentAccount(session?.user_id ?? null)
    desktopVoiceService.configureSession(session)
  }
  const serializeAuthPersistence = <T>(operation: () => Promise<T>) => {
    const result = authPersistenceTail.then(operation)
    authPersistenceTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  initializeHotkeys(getWindow)
  registerDisplayMediaIpc(getWindow)
  registerNativeMediaRuntimeIpc(getWindow)
  const unsubscribeVoice = desktopVoiceService.subscribe((snapshot) => {
    broadcastDesktopVoiceSnapshot(getWindow, IPC.voiceSnapshotChanged, snapshot)
  })
  const initialAuthSessionRevision = authSessionRevision
  void serializeAuthPersistence(() =>
    loadDesktopSession(options.sessionPath),
  )
    .then((session) => {
      if (authSessionRevision !== initialAuthSessionRevision) return
      applyAuthenticatedSession(session)
    })
    .catch((error) => {
      console.error('[desktop] failed to load persisted session', error)
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

  ipcMain.handle(IPC.authLoadSession, async () => {
    const revision = authSessionRevision
    const session = await serializeAuthPersistence(() =>
      loadDesktopSession(options.sessionPath),
    )
    if (authSessionRevision !== revision) return null
    applyAuthenticatedSession(session)
    return session
  })

  ipcMain.handle(
    IPC.authSaveSession,
    async (_event, session: DesktopStoredSession) => {
      const revision = ++authSessionRevision
      await serializeAuthPersistence(async () => {
        if (authSessionRevision !== revision) return
        await saveDesktopSession(options.sessionPath, session)
        if (authSessionRevision === revision) applyAuthenticatedSession(session)
      })
    },
  )

  ipcMain.handle(IPC.authClearSession, async () => {
    const revision = ++authSessionRevision
    // Logout revokes in-memory authority immediately. Disk persistence is
    // serialized for ordering, but a slow or failed delete must never leave
    // voice and diagnostics authenticated under the retired account.
    applyAuthenticatedSession(null)
    await serializeAuthPersistence(async () => {
      if (authSessionRevision !== revision) return
      await clearDesktopSession(options.sessionPath)
    })
  })

  ipcMain.handle(IPC.voiceGetSnapshot, () => desktopVoiceService.snapshot())

  ipcMain.handle(IPC.voiceDispatch, (_event, command: unknown) => {
    if (!isVoiceCommand(command)) throw new Error('Invalid voice command')
    return desktopVoiceService.dispatch(command)
  })

  ipcMain.handle(IPC.settingsLoad, () =>
    loadDesktopLocalSettings(
      options.localSettingsPath,
      options.localSettingsDefaults,
    ),
  )

  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: DesktopLocalSettingsPatch) => {
    const settings = await options.updateLocalSettings(patch)
    setDesktopOverlaySettings(settings.overlay)
    return settings
  })

  ipcMain.handle(
    IPC.diagnosticsCreateBundle,
    async (_event, rendererJsonl: string) => {
      await flushNativeMediaDiagnostics()
      return createDesktopDiagnosticBundle(rendererJsonl)
    },
  )
  ipcMain.handle(IPC.diagnosticsLeaseNativeIncidents, (_event, accountId) =>
    leaseNativeDiagnosticIncidents(accountId),
  )
  ipcMain.handle(IPC.diagnosticsEnqueueIncident, (_event, accountId, incident) =>
    captureRendererDiagnosticIncidentForAccount(accountId, incident),
  )
  ipcMain.handle(IPC.diagnosticsAcknowledgeNativeIncidents, (_event, accountId, batchId) =>
    acknowledgeNativeDiagnosticIncidents(accountId, batchId),
  )
  ipcMain.handle(IPC.diagnosticsReleaseNativeIncidents, (_event, accountId, batchId) =>
    releaseNativeDiagnosticIncidents(accountId, batchId),
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
    unsubscribeVoice()
  }
}

export function getLastActivity() {
  return lastActivity
}
