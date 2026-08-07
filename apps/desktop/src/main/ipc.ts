import { app, clipboard, ipcMain, type BrowserWindow } from 'electron'
import {
  ActivityDetailsSchema,
  DesktopOverlaySnapshotSchema,
  DesktopStoredSessionSchema,
  DesktopTrayVoiceStateSchema,
  HotkeyBindingSchema,
  IPC,
  RendererDiagnosticIncidentSchema,
  VoiceCommandSchema,
  type ActivityDetails,
  type DesktopLocalSettings,
  type DesktopLocalSettingsPatch,
  type DesktopStoredSession,
  type DesktopTrayVoiceState,
  type DesktopWindowPreferences,
  normalizeDesktopLocalSettingsPatch,
} from '@syrnike13/platform'
import { Effect, Schema, Semaphore } from 'effect'

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
  clearDesktopSessionEffect,
  loadDesktopSessionEffect,
  saveDesktopSessionEffect,
} from './desktop-session'
import {
  desktopLocalSettingsDefaults,
  loadDesktopLocalSettings,
} from './desktop-local-settings'
import {
  flushNativeMediaDiagnosticsEffect,
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
import { createDesktopDiagnosticBundleEffect } from './diagnostic-bundle'
import {
  acknowledgeNativeDiagnosticIncidents,
  captureRendererDiagnosticIncidentForAccount,
  configureNativeDiagnosticIncidentAccount,
  leaseNativeDiagnosticIncidents,
  releaseNativeDiagnosticIncidents,
} from './native-runtime/diagnostic-incidents'
import { decodeIpcInput } from './ipc-schema'

let lastActivity: ActivityDetails | null = null

const ActivityInputSchema = Schema.Union([
  ActivityDetailsSchema,
  Schema.Null,
])
const SettingsPatchInputSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
)
const HotkeyBindingsInputSchema = Schema.mutable(
  Schema.Array(HotkeyBindingSchema),
)
const DiagnosticIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
)

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
  const authPersistence = Semaphore.makeUnsafe(1)
  const applyAuthenticatedSession = (session: DesktopStoredSession | null) => {
    configureNativeDiagnosticIncidentAccount(session?.user_id ?? null)
    desktopVoiceService.configureSession(session)
  }
  const serializeAuthPersistence = <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => authPersistence.withPermit(operation)
  initializeHotkeys(getWindow)
  registerDisplayMediaIpc(getWindow)
  registerNativeMediaRuntimeIpc(getWindow)
  const unsubscribeVoice = desktopVoiceService.subscribe((snapshot) => {
    broadcastDesktopVoiceSnapshot(getWindow, IPC.voiceSnapshotChanged, snapshot)
  })
  const initialAuthSessionRevision = authSessionRevision
  Effect.runFork(
    serializeAuthPersistence(
      loadDesktopSessionEffect(options.sessionPath),
    ).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          if (authSessionRevision !== initialAuthSessionRevision) return
          applyAuthenticatedSession(session)
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error('[desktop] failed to load persisted session', error)
        }),
      ),
    ),
  )

  ipcMain.handle(IPC.versions, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))

  ipcMain.handle(IPC.clipboardWriteText, (_event, input: unknown) => {
    const text = decodeIpcInput(
      IPC.clipboardWriteText,
      'text',
      Schema.String,
      input,
    )
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

  ipcMain.handle(IPC.windowSetCloseToTray, (_event, input: unknown) => {
    const closeToTray = decodeIpcInput(
      IPC.windowSetCloseToTray,
      'closeToTray',
      Schema.Boolean,
      input,
    )
    return options.setCloseToTray(closeToTray)
  })

  ipcMain.handle(IPC.windowSetOpenAtLogin, (_event, input: unknown) => {
    const openAtLogin = decodeIpcInput(
      IPC.windowSetOpenAtLogin,
      'openAtLogin',
      Schema.Boolean,
      input,
    )
    return options.setOpenAtLogin(openAtLogin)
  })

  ipcMain.handle(IPC.updatesGetState, () => getDesktopUpdateState())

  ipcMain.handle(IPC.updatesCheck, () => checkForDesktopUpdates())

  ipcMain.on(IPC.updatesInstall, () => {
    quitAndInstallDesktopUpdate()
  })

  ipcMain.handle(IPC.activitySet, (_event, input: unknown) => {
    const details = decodeIpcInput(
      IPC.activitySet,
      'details',
      ActivityInputSchema,
      input,
    )
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

  ipcMain.handle(IPC.traySetVoiceState, (_event, input: unknown) => {
    const state: DesktopTrayVoiceState = decodeIpcInput(
      IPC.traySetVoiceState,
      'state',
      DesktopTrayVoiceStateSchema,
      input,
    )
    options.setTrayVoiceState(state)
  })

  ipcMain.handle(IPC.authLoadSession, async () => {
    const revision = authSessionRevision
    const session = await Effect.runPromise(
      serializeAuthPersistence(
        loadDesktopSessionEffect(options.sessionPath),
      ),
    )
    if (authSessionRevision !== revision) return null
    applyAuthenticatedSession(session)
    return session
  })

  ipcMain.handle(
    IPC.authSaveSession,
    async (_event, input: unknown) => {
      const session: DesktopStoredSession = decodeIpcInput(
        IPC.authSaveSession,
        'session',
        DesktopStoredSessionSchema,
        input,
      )
      const revision = ++authSessionRevision
      await Effect.runPromise(
        serializeAuthPersistence(
          Effect.gen(function*() {
            if (authSessionRevision !== revision) return
            yield* saveDesktopSessionEffect(options.sessionPath, session)
            if (authSessionRevision === revision) {
              yield* Effect.sync(() => applyAuthenticatedSession(session))
            }
          }),
        ),
      )
    },
  )

  ipcMain.handle(IPC.authClearSession, async () => {
    const revision = ++authSessionRevision
    // Logout revokes in-memory authority immediately. Disk persistence is
    // serialized for ordering, but a slow or failed delete must never leave
    // voice and diagnostics authenticated under the retired account.
    applyAuthenticatedSession(null)
    await Effect.runPromise(
      serializeAuthPersistence(
        Effect.gen(function*() {
          if (authSessionRevision !== revision) return
          yield* clearDesktopSessionEffect(options.sessionPath)
        }),
      ),
    )
  })

  ipcMain.handle(IPC.voiceGetSnapshot, () => desktopVoiceService.snapshot())

  ipcMain.handle(IPC.voiceDispatch, (_event, input: unknown) => {
    const command = decodeIpcInput(
      IPC.voiceDispatch,
      'command',
      VoiceCommandSchema,
      input,
    )
    return desktopVoiceService.dispatch(command)
  })

  ipcMain.handle(IPC.settingsLoad, () =>
    loadDesktopLocalSettings(
      options.localSettingsPath,
      options.localSettingsDefaults,
    ),
  )

  ipcMain.handle(IPC.settingsUpdate, async (_event, input: unknown) => {
    const patch: DesktopLocalSettingsPatch = normalizeDesktopLocalSettingsPatch(
      decodeIpcInput(
        IPC.settingsUpdate,
        'patch',
        SettingsPatchInputSchema,
        input,
      ),
    )
    const settings = await options.updateLocalSettings(patch)
    setDesktopOverlaySettings(settings.overlay)
    return settings
  })

  ipcMain.handle(
    IPC.diagnosticsCreateBundle,
    (_event, input: unknown) => {
      const rendererJsonl = decodeIpcInput(
        IPC.diagnosticsCreateBundle,
        'rendererJsonl',
        Schema.String,
        input,
      )
      return Effect.runPromise(
        Effect.gen(function*() {
          yield* flushNativeMediaDiagnosticsEffect()
          return yield* createDesktopDiagnosticBundleEffect(rendererJsonl)
        }),
      )
    },
  )
  ipcMain.handle(
    IPC.diagnosticsLeaseNativeIncidents,
    (_event, accountInput: unknown) => {
      const accountId = decodeIpcInput(
        IPC.diagnosticsLeaseNativeIncidents,
        'accountId',
        DiagnosticIdentifierSchema,
        accountInput,
      )
      return leaseNativeDiagnosticIncidents(accountId)
    },
  )
  ipcMain.handle(
    IPC.diagnosticsEnqueueIncident,
    (_event, accountInput: unknown, incidentInput: unknown) => {
      const accountId = decodeIpcInput(
        IPC.diagnosticsEnqueueIncident,
        'accountId',
        DiagnosticIdentifierSchema,
        accountInput,
      )
      const incident = decodeIpcInput(
        IPC.diagnosticsEnqueueIncident,
        'incident',
        RendererDiagnosticIncidentSchema,
        incidentInput,
      )
      return captureRendererDiagnosticIncidentForAccount(accountId, incident)
    },
  )
  ipcMain.handle(
    IPC.diagnosticsAcknowledgeNativeIncidents,
    (_event, accountInput: unknown, batchInput: unknown) => {
      const accountId = decodeIpcInput(
        IPC.diagnosticsAcknowledgeNativeIncidents,
        'accountId',
        DiagnosticIdentifierSchema,
        accountInput,
      )
      const batchId = decodeIpcInput(
        IPC.diagnosticsAcknowledgeNativeIncidents,
        'batchId',
        DiagnosticIdentifierSchema,
        batchInput,
      )
      return acknowledgeNativeDiagnosticIncidents(accountId, batchId)
    },
  )
  ipcMain.handle(
    IPC.diagnosticsReleaseNativeIncidents,
    (_event, accountInput: unknown, batchInput: unknown) => {
      const accountId = decodeIpcInput(
        IPC.diagnosticsReleaseNativeIncidents,
        'accountId',
        DiagnosticIdentifierSchema,
        accountInput,
      )
      const batchId = decodeIpcInput(
        IPC.diagnosticsReleaseNativeIncidents,
        'batchId',
        DiagnosticIdentifierSchema,
        batchInput,
      )
      return releaseNativeDiagnosticIncidents(accountId, batchId)
    },
  )

  ipcMain.handle(IPC.hotkeysGetBindings, () => getHotkeyBindings())

  ipcMain.handle(IPC.hotkeysSetBindings, (_event, input: unknown) => {
    const bindings = decodeIpcInput(
      IPC.hotkeysSetBindings,
      'bindings',
      HotkeyBindingsInputSchema,
      input,
    )
    return setHotkeyBindings(bindings)
  })

  ipcMain.handle(IPC.hotkeysSetSuspended, (_event, input: unknown) => {
    const suspended = decodeIpcInput(
      IPC.hotkeysSetSuspended,
      'suspended',
      Schema.Boolean,
      input,
    )
    setHotkeysSuspended(suspended)
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

  ipcMain.handle(IPC.overlaySetEnabled, (event, input: unknown) => {
    if (!canSetDesktopOverlaySnapshot(event.sender)) {
      throw new Error('Untrusted overlay settings request')
    }
    const enabled = decodeIpcInput(
      IPC.overlaySetEnabled,
      'enabled',
      Schema.Boolean,
      input,
    )
    return setDesktopOverlayEnabled(enabled)
  })

  ipcMain.handle(
    IPC.overlaySetSnapshot,
    (event, input: unknown) => {
      if (!canSetDesktopOverlaySnapshot(event.sender)) {
        throw new Error('Untrusted overlay snapshot request')
      }
      const snapshot = decodeIpcInput(
        IPC.overlaySetSnapshot,
        'snapshot',
        DesktopOverlaySnapshotSchema,
        input,
      )
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
