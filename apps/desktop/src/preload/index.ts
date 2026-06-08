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
  NativeMediaDeviceInfo,
  NativeMicrophonePreviewSession,
  NativeMicrophonePreviewStartOptions,
  NativeMediaSession,
  NativeMediaSidecarLostEvent,
  NativeMediaSessionStartOptions,
  NativeMediaState,
  NativeMediaStateEvent,
  NativeMediaStatsEvent,
  NativeMicrophoneMetricsEvent,
  NativeMicrophoneRuntimeConfig,
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
  media: {
    getDisplaySources(requestId: string) {
      return ipcRenderer.invoke(
        IPC.mediaGetDisplaySources,
        requestId,
      ) as Promise<DesktopDisplayMediaSource[]>
    },
    selectDisplaySource(requestId: string, sourceId: string) {
      return ipcRenderer.invoke(
        IPC.mediaSelectDisplaySource,
        requestId,
        sourceId,
      ) as Promise<boolean>
    },
    cancelRequest(requestId: string) {
      return ipcRenderer.invoke(IPC.mediaCancelRequest, requestId)
    },
    openDisplayPicker(audioRequested: boolean) {
      return ipcRenderer.invoke(
        IPC.mediaOpenDisplayPicker,
        audioRequested,
      ) as Promise<DesktopDisplayMediaRequest>
    },
    listDevices(kind: 'audioinput') {
      return ipcRenderer.invoke(
        IPC.mediaListDevices,
        kind,
      ) as Promise<NativeMediaDeviceInfo[]>
    },
    startMicrophonePreview(options: NativeMicrophonePreviewStartOptions) {
      return ipcRenderer.invoke(
        IPC.mediaStartMicrophonePreview,
        options,
      ) as Promise<NativeMicrophonePreviewSession>
    },
    stopMicrophonePreview(sessionId?: string) {
      return ipcRenderer.invoke(IPC.mediaStopMicrophonePreview, sessionId)
    },
    onRequest(handler: (request: DesktopDisplayMediaRequest) => void) {
      const listener = (_event: Electron.IpcRendererEvent, request: unknown) => {
        if (isDesktopDisplayMediaRequest(request)) handler(request)
      }
      ipcRenderer.on(IPC.mediaRequest, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaRequest, listener)
      }
    },
    onDisplayPickerResolved(
      handler: (payload: { requestId: string; sourceId: string }) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativePickerResolved(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaDisplayPickerResolved, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaDisplayPickerResolved, listener)
      }
    },
    startSession(options: NativeMediaSessionStartOptions) {
      return ipcRenderer.invoke(IPC.mediaStartSession, options) as Promise<NativeMediaSession>
    },
    configureMicrophoneRuntime(
      sessionId: string,
      config: NativeMicrophoneRuntimeConfig,
    ) {
      return ipcRenderer.invoke(
        IPC.mediaConfigureMicrophoneRuntime,
        sessionId,
        config,
      )
    },
    stopSession(sessionId?: string) {
      return ipcRenderer.invoke(IPC.mediaStopSession, sessionId)
    },
    getState() {
      return ipcRenderer.invoke(IPC.mediaGetState) as Promise<NativeMediaState>
    },
    onStats(handler: (event: NativeMediaStatsEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeMediaStatsEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaStats, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaStats, listener)
      }
    },
    onMicrophoneMetrics(handler: (event: NativeMicrophoneMetricsEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeMicrophoneMetricsEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaMicrophoneMetrics, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaMicrophoneMetrics, listener)
      }
    },
    onStateChange(handler: (event: NativeMediaStateEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeMediaStateEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaStateChanged, listener)
      }
    },
    readSharedFrame(sessionId: string) {
      return ipcRenderer.invoke(
        IPC.mediaReadSharedFrame,
        sessionId,
      ) as Promise<ArrayBuffer | null>
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
      ipcRenderer.on(IPC.mediaStreamChunk, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaStreamChunk, listener)
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
      ipcRenderer.on(IPC.mediaStreamAudioChunk, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaStreamAudioChunk, listener)
      }
    },
    onStreamEnded(handler: (sessionId: string) => void) {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: unknown) => {
        if (typeof sessionId === 'string') handler(sessionId)
      }
      ipcRenderer.on(IPC.mediaStreamEnded, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaStreamEnded, listener)
      }
    },
    onStreamError(
      handler: (event: { sessionId: string; message: string }) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isCaptureStreamError(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaStreamError, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaStreamError, listener)
      }
    },
    onSidecarLost(handler: (event: NativeMediaSidecarLostEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeMediaSidecarLostEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaEngineLost, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaEngineLost, listener)
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

function isNativeMediaStatsEvent(value: unknown): value is NativeMediaStatsEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeMediaStatsEvent
  return typeof event.sessionId === 'string' && typeof event.methods === 'object'
}

function isNativeMicrophoneMetricsEvent(
  value: unknown,
): value is NativeMicrophoneMetricsEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeMicrophoneMetricsEvent
  return (
    typeof event.sessionId === 'string' &&
    typeof event.inputDb === 'number' &&
    typeof event.thresholdDb === 'number' &&
    typeof event.open === 'boolean'
  )
}

function isNativeMediaStateEvent(value: unknown): value is NativeMediaStateEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeMediaStateEvent
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

function isNativeMediaSidecarLostEvent(
  value: unknown,
): value is NativeMediaSidecarLostEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeMediaSidecarLostEvent
  return (
    typeof event.sessionId === 'string' &&
    (event.reason === 'exit' || event.reason === 'stream_error') &&
    typeof event.message === 'string'
  )
}
