import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@syrnike13/platform'

import type {
  DesktopOs,
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSource,
  DesktopPlatformInfo,
  DesktopStoredSession,
  DesktopUpdateState,
  HotkeyActivationEvent,
  HotkeyAction,
  HotkeyBinding,
  MediaEngineEvent,
  NativeInputEvent,
  SyrnikeDesktopApi,
} from '@syrnike13/platform'

function resolveDesktopOs(): DesktopOs {
  switch (process.platform) {
    case 'darwin':
      return 'darwin'
    case 'win32':
      return 'win32'
    default:
      return 'linux'
  }
}

const platform: DesktopPlatformInfo = {
  os: resolveDesktopOs(),
}

const syrnikeDesktop: SyrnikeDesktopApi = {
  runtime: 'desktop',
  platform,
  getVersions() {
    return ipcRenderer.invoke(IPC.versions)
  },
  window: {
    minimize() {
      ipcRenderer.send(IPC.windowMinimize)
    },
    maximize() {
      ipcRenderer.send(IPC.windowMaximize)
    },
    close() {
      ipcRenderer.send(IPC.windowClose)
    },
    show() {
      ipcRenderer.send(IPC.windowShow)
    },
    isMaximized() {
      return ipcRenderer.invoke(IPC.windowIsMaximized)
    },
    getPreferences() {
      return ipcRenderer.invoke(IPC.windowGetPreferences)
    },
    setCloseToTray(closeToTray: boolean) {
      return ipcRenderer.invoke(IPC.windowSetCloseToTray, closeToTray)
    },
    setOpenAtLogin(openAtLogin: boolean) {
      return ipcRenderer.invoke(IPC.windowSetOpenAtLogin, openAtLogin)
    },
  },
  activity: {
    set(details) {
      return ipcRenderer.invoke(IPC.activitySet, details)
    },
    clear() {
      return ipcRenderer.invoke(IPC.activityClear)
    },
  },
  auth: {
    loadSession() {
      return ipcRenderer.invoke(IPC.authLoadSession)
    },
    saveSession(session: DesktopStoredSession) {
      return ipcRenderer.invoke(IPC.authSaveSession, session)
    },
    clearSession() {
      return ipcRenderer.invoke(IPC.authClearSession)
    },
  },
  updates: {
    getState() {
      return ipcRenderer.invoke(IPC.updatesGetState)
    },
    check() {
      return ipcRenderer.invoke(IPC.updatesCheck)
    },
    install() {
      ipcRenderer.send(IPC.updatesInstall)
    },
    onStateChange(handler: (state: DesktopUpdateState) => void) {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (isDesktopUpdateState(state)) handler(state)
      }
      ipcRenderer.on(IPC.updatesStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.updatesStateChanged, listener)
      }
    },
  },
  hotkeys: {
    getBindings() {
      return ipcRenderer.invoke(IPC.hotkeysGetBindings)
    },
    setBindings(bindings: HotkeyBinding[]) {
      return ipcRenderer.invoke(IPC.hotkeysSetBindings, bindings)
    },
    setSuspended(suspended: boolean) {
      return ipcRenderer.invoke(IPC.hotkeysSetSuspended, suspended)
    },
    startRecording() {
      return ipcRenderer.invoke(IPC.hotkeysStartRecording)
    },
    stopRecording() {
      return ipcRenderer.invoke(IPC.hotkeysStopRecording)
    },
    getRuntimeStatus() {
      return ipcRenderer.invoke(IPC.hotkeysGetRuntimeStatus)
    },
    onRecordedInput(handler: (event: NativeInputEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => {
        if (input && typeof input === 'object') handler(input as NativeInputEvent)
      }
      ipcRenderer.on(IPC.hotkeysRecordedInput, listener)
      return () => {
        ipcRenderer.removeListener(IPC.hotkeysRecordedInput, listener)
      }
    },
    onPressed(handler: (event: HotkeyActivationEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => {
        if (isHotkeyActivationEvent(input)) handler(input)
      }
      ipcRenderer.on(IPC.hotkeysPressed, listener)
      return () => {
        ipcRenderer.removeListener(IPC.hotkeysPressed, listener)
      }
    },
  },
  screenShare: {
    getSources(requestId: string) {
      return ipcRenderer.invoke(
        IPC.screenShareGetSources,
        requestId,
      ) as Promise<DesktopDisplayMediaSource[]>
    },
    selectSource(requestId: string, sourceId: string) {
      return ipcRenderer.invoke(
        IPC.screenShareSelectSource,
        requestId,
        sourceId,
      ) as Promise<boolean>
    },
    cancelRequest(requestId: string) {
      return ipcRenderer.invoke(IPC.screenShareCancelRequest, requestId)
    },
    onRequest(handler: (request: DesktopDisplayMediaRequest) => void) {
      const listener = (_event: Electron.IpcRendererEvent, request: unknown) => {
        if (isDesktopDisplayMediaRequest(request)) handler(request)
      }
      ipcRenderer.on(IPC.screenShareRequest, listener)
      return () => {
        ipcRenderer.removeListener(IPC.screenShareRequest, listener)
      }
    },
  },
  mediaEngine: {
    ping() {
      return ipcRenderer.invoke(IPC.mediaEnginePing)
    },
    getStatus() {
      return ipcRenderer.invoke(IPC.mediaEngineGetStatus)
    },
    roomConnect(params) {
      return ipcRenderer.invoke(IPC.mediaEngineRoomConnect, params)
    },
    roomDisconnect() {
      return ipcRenderer.invoke(IPC.mediaEngineRoomDisconnect)
    },
    publishTestTone() {
      return ipcRenderer.invoke(IPC.mediaEnginePublishTestTone)
    },
    onEvent(handler: (event: MediaEngineEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isMediaEngineEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaEngineEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaEngineEvent, listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('syrnikeDesktop', syrnikeDesktop)

function isDesktopUpdateState(value: unknown): value is DesktopUpdateState {
  if (!value || typeof value !== 'object') return false
  const state = value as DesktopUpdateState
  switch (state.status) {
    case 'idle':
    case 'checking':
      return true
    case 'available':
    case 'ready':
      return typeof state.version === 'string'
    case 'downloading':
      return typeof state.percent === 'number'
    case 'error':
      return typeof state.message === 'string'
    default:
      return false
  }
}

function isHotkeyActivationEvent(value: unknown): value is HotkeyActivationEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as HotkeyActivationEvent
  return (
    typeof event.action === 'string' &&
    (event.phase === 'pressed' || event.phase === 'released')
  )
}

function isMediaEngineEvent(value: unknown): value is MediaEngineEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as MediaEngineEvent
  return typeof event.event === 'string' && typeof event.params === 'object'
}

function isDesktopDisplayMediaRequest(
  value: unknown,
): value is DesktopDisplayMediaRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as DesktopDisplayMediaRequest
  return (
    typeof request.id === 'string' &&
    typeof request.audioRequested === 'boolean'
  )
}
