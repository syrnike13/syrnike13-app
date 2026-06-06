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
  NativeCaptureSession,
  NativeCaptureSidecarLostEvent,
  NativeCaptureStartOptions,
  NativeCaptureState,
  NativeCaptureStateEvent,
  NativeCaptureStatsEvent,
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
    openNativePicker(audioRequested: boolean) {
      return ipcRenderer.invoke(
        IPC.screenShareOpenNativePicker,
        audioRequested,
      ) as Promise<DesktopDisplayMediaRequest>
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
    onNativePickerResolved(
      handler: (payload: { requestId: string; sourceId: string }) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativePickerResolved(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.captureNativePickerResolved, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureNativePickerResolved, listener)
      }
    },
  },
  capture: {
    start(options: NativeCaptureStartOptions) {
      return ipcRenderer.invoke(IPC.captureStart, options) as Promise<NativeCaptureSession>
    },
    stop(sessionId?: string) {
      return ipcRenderer.invoke(IPC.captureStop, sessionId)
    },
    getState() {
      return ipcRenderer.invoke(IPC.captureGetState) as Promise<NativeCaptureState>
    },
    onStats(handler: (event: NativeCaptureStatsEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeCaptureStatsEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.captureStats, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureStats, listener)
      }
    },
    onStateChange(handler: (event: NativeCaptureStateEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeCaptureStateEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.captureStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureStateChanged, listener)
      }
    },
    readSharedFrame(sessionId: string) {
      return ipcRenderer.invoke(
        IPC.captureReadSharedFrame,
        sessionId,
      ) as Promise<ArrayBuffer | null>
    },
    prepareSystemAudio(sourceId: string) {
      return ipcRenderer.invoke(IPC.capturePrepareSystemAudio, sourceId)
    },
    clearSystemAudio() {
      return ipcRenderer.invoke(IPC.captureClearSystemAudio)
    },
    onStreamChunk(
      handler: (event: { sessionId: string; chunk: ArrayBuffer }) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (!isCaptureStreamChunk(payload)) return
        handler({
          sessionId: payload.sessionId,
          chunk: normalizeCaptureChunk(payload.chunk),
        })
      }
      ipcRenderer.on(IPC.captureStreamChunk, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureStreamChunk, listener)
      }
    },
    onStreamAudioChunk(
      handler: (event: { sessionId: string; chunk: ArrayBuffer }) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (!isCaptureStreamChunk(payload)) return
        handler({
          sessionId: payload.sessionId,
          chunk: normalizeCaptureChunk(payload.chunk),
        })
      }
      ipcRenderer.on(IPC.captureStreamAudioChunk, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureStreamAudioChunk, listener)
      }
    },
    onStreamEnded(handler: (sessionId: string) => void) {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: unknown) => {
        if (typeof sessionId === 'string') handler(sessionId)
      }
      ipcRenderer.on(IPC.captureStreamEnded, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureStreamEnded, listener)
      }
    },
    onStreamError(
      handler: (event: { sessionId: string; message: string }) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isCaptureStreamError(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.captureStreamError, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureStreamError, listener)
      }
    },
    onSidecarLost(handler: (event: NativeCaptureSidecarLostEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeCaptureSidecarLostEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.captureSidecarLost, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureSidecarLost, listener)
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

function isNativePickerResolved(
  value: unknown,
): value is { requestId: string; sourceId: string } {
  if (!value || typeof value !== 'object') return false
  const payload = value as { requestId?: unknown; sourceId?: unknown }
  return (
    typeof payload.requestId === 'string' && typeof payload.sourceId === 'string'
  )
}

function isNativeCaptureStatsEvent(value: unknown): value is NativeCaptureStatsEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeCaptureStatsEvent
  return typeof event.sessionId === 'string' && typeof event.methods === 'object'
}

function isNativeCaptureStateEvent(value: unknown): value is NativeCaptureStateEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeCaptureStateEvent
  return typeof event.status === 'string'
}

function isBinaryChunk(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function normalizeCaptureChunk(chunk: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (chunk instanceof ArrayBuffer) return chunk
  return chunk.buffer.slice(
    chunk.byteOffset,
    chunk.byteOffset + chunk.byteLength,
  ) as ArrayBuffer
}

function isCaptureStreamChunk(
  value: unknown,
): value is { sessionId: string; chunk: ArrayBuffer | ArrayBufferView } {
  if (!value || typeof value !== 'object') return false
  const event = value as { sessionId?: unknown; chunk?: unknown }
  return typeof event.sessionId === 'string' && isBinaryChunk(event.chunk)
}

function isCaptureStreamError(
  value: unknown,
): value is { sessionId: string; message: string } {
  if (!value || typeof value !== 'object') return false
  const event = value as { sessionId?: unknown; message?: unknown }
  return typeof event.sessionId === 'string' && typeof event.message === 'string'
}

function isNativeCaptureSidecarLostEvent(
  value: unknown,
): value is NativeCaptureSidecarLostEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeCaptureSidecarLostEvent
  return (
    typeof event.sessionId === 'string' &&
    (event.reason === 'exit' || event.reason === 'stream_error') &&
    typeof event.message === 'string'
  )
}
