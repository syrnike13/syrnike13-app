import { contextBridge, ipcRenderer, sharedTexture } from 'electron'
import {
  IPC,
  isVoiceSnapshot,
} from '@syrnike13/platform'

import type {
  DesktopOverlaySnapshot,
  DesktopOverlayState,
  DesktopOs,
  DesktopLocalSettings,
  DesktopLocalSettingsPatch,
  NativeDiagnosticIncidentBatch,
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSelection,
  DesktopDisplayMediaSource,
  DesktopPlatformInfo,
  DesktopStoredSession,
  DesktopUpdateState,
  DesktopTrayVoiceState,
  HotkeyActivationEvent,
  HotkeyAction,
  HotkeyBinding,
  NativeMediaDeviceInfo,
  NativeMicrophoneMetricsEvent,
  NativeMicrophonePreviewStateEvent,
  NativeInputEvent,
  SyrnikeDesktopApi,
  VoiceCommand,
  VoiceSnapshot,
} from '@syrnike13/platform'

const NATIVE_VIDEO_FRAME_MESSAGE = 'syrnike-native-video-frame'

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  let frame: VideoFrame | null = null
  try {
    frame = importedSharedTexture.getVideoFrame()
    window.postMessage(
      { type: NATIVE_VIDEO_FRAME_MESSAGE, metadata, frame },
      window.location.origin,
      [frame],
    )
    frame = null
  } finally {
    frame?.close()
    importedSharedTexture.release()
  }
})

ipcRenderer.on('syrnike-desktop:media:remote-video-track-removed', (_event, metadata) => {
  window.postMessage(
    { type: 'syrnike-native-video-track-removed', metadata },
    window.location.origin,
  )
})

ipcRenderer.on(
  'syrnike-desktop:media:remote-video-subscription-failed',
  (_event, metadata) => {
    window.postMessage(
      { type: 'syrnike-native-video-subscription-failed', metadata },
      window.location.origin,
    )
  },
)

for (const state of ['available', 'unavailable'] as const) {
  ipcRenderer.on(
    `syrnike-desktop:media:remote-screen-publication-${state}`,
    (_event, metadata) => {
      window.postMessage(
        { type: `syrnike-native-screen-publication-${state}`, metadata },
        window.location.origin,
      )
    },
  )
}

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
  clipboard: {
    writeText(text: string) {
      return ipcRenderer.invoke(IPC.clipboardWriteText, text)
    },
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
  tray: {
    setVoiceState(state: DesktopTrayVoiceState) {
      return ipcRenderer.invoke(IPC.traySetVoiceState, state)
    },
  },
  voice: {
    dispatch(command: VoiceCommand) {
      return ipcRenderer.invoke(IPC.voiceDispatch, command) as Promise<VoiceSnapshot>
    },
    getSnapshot() {
      return ipcRenderer.invoke(IPC.voiceGetSnapshot) as Promise<VoiceSnapshot>
    },
    onSnapshot(handler: (snapshot: VoiceSnapshot) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isVoiceSnapshot(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.voiceSnapshotChanged, listener)
      return () => ipcRenderer.removeListener(IPC.voiceSnapshotChanged, listener)
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
  settings: {
    load() {
      return ipcRenderer.invoke(IPC.settingsLoad) as Promise<DesktopLocalSettings>
    },
    update(patch: DesktopLocalSettingsPatch) {
      return ipcRenderer.invoke(
        IPC.settingsUpdate,
        patch,
      ) as Promise<DesktopLocalSettings>
    },
  },
  diagnostics: {
    async createBundle(rendererJsonl: string) {
      const value = await ipcRenderer.invoke(
        IPC.diagnosticsCreateBundle,
        rendererJsonl,
      )
      return new Uint8Array(value)
    },
    leaseNativeIncidents() {
      return ipcRenderer.invoke(
        IPC.diagnosticsLeaseNativeIncidents,
      ) as Promise<NativeDiagnosticIncidentBatch | null>
    },
    acknowledgeNativeIncidents(batchId: string) {
      return ipcRenderer.invoke(
        IPC.diagnosticsAcknowledgeNativeIncidents,
        batchId,
      ) as Promise<boolean>
    },
    releaseNativeIncidents(batchId: string) {
      return ipcRenderer.invoke(
        IPC.diagnosticsReleaseNativeIncidents,
        batchId,
      ) as Promise<boolean>
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
  overlay: {
    getState() {
      return ipcRenderer.invoke(IPC.overlayGetState) as Promise<DesktopOverlayState>
    },
    setEnabled(enabled: boolean) {
      return ipcRenderer.invoke(
        IPC.overlaySetEnabled,
        enabled,
      ) as Promise<DesktopOverlayState>
    },
    setSnapshot(snapshot: DesktopOverlaySnapshot) {
      return ipcRenderer.invoke(
        IPC.overlaySetSnapshot,
        snapshot,
      ) as Promise<DesktopOverlayState>
    },
    onStateChange(handler: (state: DesktopOverlayState) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isDesktopOverlayState(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.overlayStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.overlayStateChanged, listener)
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
    selectDisplaySource(
      requestId: string,
      sourceId: string,
      audioRequested?: boolean,
    ) {
      return ipcRenderer.invoke(
        IPC.mediaSelectDisplaySource,
        requestId,
        sourceId,
        audioRequested,
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
    listDevices(kind: 'audioinput' | 'audiooutput' | 'videoinput') {
      return ipcRenderer.invoke(
        IPC.mediaListDevices,
        kind,
      ) as Promise<NativeMediaDeviceInfo[]>
    },
    startMicrophonePreview() {
      return ipcRenderer.invoke(IPC.mediaStartMicrophonePreview) as Promise<void>
    },
    stopMicrophonePreview() {
      return ipcRenderer.invoke(IPC.mediaStopMicrophonePreview)
    },
    setRemoteVideoDemand(sessionId, generation, trackId, demanded) {
      return ipcRenderer.invoke(
        IPC.mediaSetRemoteVideoDemand,
        sessionId,
        generation,
        trackId,
        demanded,
      )
    },
    setLocalScreenPreviewDemand(demand) {
      return ipcRenderer.invoke(IPC.mediaSetLocalScreenPreviewDemand, demand)
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
      handler: (payload: DesktopDisplayMediaSelection) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativePickerResolved(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaDisplayPickerResolved, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaDisplayPickerResolved, listener)
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
    onMicrophonePreviewState(
      handler: (event: NativeMicrophonePreviewStateEvent) => void,
    ) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeMicrophonePreviewStateEvent(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaMicrophonePreviewState, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaMicrophonePreviewState, listener)
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
    case 'installing':
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
): value is DesktopDisplayMediaSelection {
  if (!value || typeof value !== 'object') return false
  const payload = value as {
    requestId?: unknown
    sourceId?: unknown
    audioRequested?: unknown
  }
  return (
    typeof payload.requestId === 'string' &&
    typeof payload.sourceId === 'string' &&
    typeof payload.audioRequested === 'boolean'
  )
}

function isDesktopOverlayState(value: unknown): value is DesktopOverlayState {
  if (!value || typeof value !== 'object') return false
  const state = value as DesktopOverlayState
  return (
    typeof state.available === 'boolean' &&
    typeof state.enabled === 'boolean' &&
    typeof state.visible === 'boolean' &&
    (state.target === null ||
      (typeof state.target === 'object' &&
        typeof state.target.gameId === 'string' &&
        typeof state.target.processName === 'string' &&
        (typeof state.target.processPath === 'string' ||
          state.target.processPath === null) &&
        typeof state.target.title === 'string' &&
        isDesktopOverlayBounds(state.target.bounds))) &&
    isDesktopOverlaySnapshot(state.snapshot)
  )
}

function isDesktopOverlayBounds(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const bounds = value as {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
  }
  return (
    typeof bounds.x === 'number' &&
    Number.isFinite(bounds.x) &&
    typeof bounds.y === 'number' &&
    Number.isFinite(bounds.y) &&
    typeof bounds.width === 'number' &&
    Number.isFinite(bounds.width) &&
    typeof bounds.height === 'number' &&
    Number.isFinite(bounds.height)
  )
}

function isDesktopOverlaySnapshot(
  value: unknown,
): value is DesktopOverlaySnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as DesktopOverlaySnapshot
  return (
    typeof snapshot.active === 'boolean' &&
    (typeof snapshot.channelId === 'string' || snapshot.channelId === null) &&
    (typeof snapshot.channelLabel === 'string' || snapshot.channelLabel === null) &&
    Array.isArray(snapshot.participants) &&
    snapshot.participants.every((participant) => {
      if (!participant || typeof participant !== 'object') return false
      const item = participant as DesktopOverlaySnapshot['participants'][number]
      return (
        typeof item.userId === 'string' &&
        typeof item.displayName === 'string' &&
        (typeof item.avatarUrl === 'string' || item.avatarUrl === null) &&
        typeof item.speaking === 'boolean' &&
        typeof item.muted === 'boolean' &&
        typeof item.deafened === 'boolean'
      )
    })
  )
}

function isNativeMicrophoneMetricsEvent(
  value: unknown,
): value is NativeMicrophoneMetricsEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as NativeMicrophoneMetricsEvent
  return (
    typeof event.inputDb === 'number' &&
    typeof event.thresholdDb === 'number' &&
    typeof event.open === 'boolean'
  )
}

function isNativeMicrophonePreviewStateEvent(
  value: unknown,
): value is NativeMicrophonePreviewStateEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as { status?: unknown; message?: unknown }
  if (event.status === 'running' || event.status === 'stopped') {
    return event.message === undefined
  }
  return event.status === 'error' && typeof event.message === 'string'
}
