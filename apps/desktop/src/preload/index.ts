import { contextBridge, ipcRenderer, sharedTexture } from 'electron'
import {
  DesktopDisplayMediaRequestSchema,
  DesktopDisplayMediaSelectionSchema,
  DesktopDisplayMediaSourceSchema,
  DesktopOverlayStateSchema,
  DesktopStoredSessionSchema,
  DesktopUpdateStateSchema,
  DesktopVersionsSchema,
  DesktopWindowPreferencesSchema,
  HotkeyActivationEventSchema,
  HotkeyBindingSchema,
  HotkeyRegistrationResultSchema,
  HotkeyRuntimeStatusSchema,
  IPC,
  NativeDiagnosticIncidentBatchSchema,
  NativeInputEventSchema,
  NativeMediaDeviceInfoSchema,
  NativeMediaRuntimeStateSchema,
  NativeMicrophoneMetricsEventSchema,
  NativeMicrophonePreviewStateEventSchema,
  VoiceSnapshotSchema,
  VoiceRtcTelemetrySnapshotSchema,
  normalizeDesktopLocalSettings,
} from '@syrnike13/platform'
import { Effect, Schema } from 'effect'

import type {
  DesktopOverlaySnapshot,
  DesktopOverlayState,
  DesktopOs,
  DesktopLocalSettingsPatch,
  RendererDiagnosticIncident,
  DesktopDisplayMediaRequest,
  DesktopDisplayMediaSelection,
  DesktopDisplayMediaSource,
  DesktopPlatformInfo,
  DesktopStoredSession,
  DesktopUpdateState,
  DesktopTrayVoiceState,
  HotkeyActivationEvent,
  HotkeyBinding,
  NativeMediaDeviceInfo,
  NativeMediaRuntimeState,
  NativeMicrophoneMetricsEvent,
  NativeMicrophonePreviewStateEvent,
  NativeInputEvent,
  SyrnikeDesktopApi,
  VoiceCommand,
  VoiceSnapshot,
  VoiceRtcTelemetrySnapshot,
} from '@syrnike13/platform'

const NATIVE_VIDEO_FRAME_MESSAGE = 'syrnike-native-video-frame'

type MutableResponse<T> = T extends Uint8Array
  ? T
  : T extends ReadonlyArray<infer Item>
    ? Array<MutableResponse<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: MutableResponse<T[Key]> }
      : T

function mutableResponseSchema<
  ResponseSchema extends Schema.ConstraintDecoder<unknown, never>,
>(responseSchema: ResponseSchema) {
  const isResponse = Schema.is(responseSchema)
  return Schema.declare<MutableResponse<ResponseSchema['Type']>>(
    (input): input is MutableResponse<ResponseSchema['Type']> =>
      isResponse(input),
  )
}

const invokeDecodedEffect = Effect.fn('desktopPreload.invokeDecoded')(
  function*<
    ResponseSchema extends Schema.ConstraintDecoder<unknown, never>,
  >(
    channel: string,
    responseSchema: ResponseSchema,
    ...args: unknown[]
  ) {
    const response: unknown = yield* Effect.tryPromise({
      try: () => ipcRenderer.invoke(channel, ...args),
      catch: (cause) => cause,
    })
    return yield* Schema.decodeUnknownEffect(
      mutableResponseSchema(responseSchema),
    )(response).pipe(
      Effect.mapError(
        () => new TypeError(`Invalid IPC response for ${channel}`),
      ),
    )
  },
)

function invokeDecoded<
  ResponseSchema extends Schema.ConstraintDecoder<unknown, never>,
>(
  channel: string,
  responseSchema: ResponseSchema,
  ...args: unknown[]
): Promise<MutableResponse<ResponseSchema['Type']>> {
  return Effect.runPromise(
    invokeDecodedEffect(channel, responseSchema, ...args),
  )
}

const invokeNativeMediaRuntimeStateEffect = Effect.fn(
  'desktopPreload.invokeNativeMediaRuntimeState',
)(function*(channel: string) {
  return yield* invokeDecodedEffect(
    channel,
    NativeMediaRuntimeStateSchema,
  ).pipe(
    Effect.mapError(
      () => new TypeError('Invalid native media runtime state'),
    ),
  )
})

function invokeNativeMediaRuntimeState(channel: string) {
  return Effect.runPromise(invokeNativeMediaRuntimeStateEffect(channel))
}

const HotkeyBindingsSchema = Schema.mutable(
  Schema.Array(HotkeyBindingSchema),
)
const HotkeyRegistrationResultsSchema = Schema.mutable(
  Schema.Array(HotkeyRegistrationResultSchema),
)
const DesktopDisplayMediaSourcesSchema = Schema.mutable(
  Schema.Array(DesktopDisplayMediaSourceSchema),
)
const NativeMediaDevicesSchema = Schema.mutable(
  Schema.Array(NativeMediaDeviceInfoSchema),
)
const StoredSessionResultSchema = Schema.Union([
  DesktopStoredSessionSchema,
  Schema.Null,
])
const NativeIncidentLeaseSchema = Schema.Union([
  NativeDiagnosticIncidentBatchSchema,
  Schema.Null,
])

const isDesktopUpdateState = Schema.is(DesktopUpdateStateSchema)
const isHotkeyActivationEvent = Schema.is(HotkeyActivationEventSchema)
const isDesktopDisplayMediaRequest = Schema.is(
  DesktopDisplayMediaRequestSchema,
)
const isNativePickerResolved = Schema.is(
  DesktopDisplayMediaSelectionSchema,
)
const isDesktopOverlayState = Schema.is(DesktopOverlayStateSchema)
const isNativeMicrophoneMetricsEvent = Schema.is(
  NativeMicrophoneMetricsEventSchema,
)
const isNativeMicrophonePreviewStateEvent = Schema.is(
  NativeMicrophonePreviewStateEventSchema,
)
const isNativeMediaRuntimeState = Schema.is(NativeMediaRuntimeStateSchema)
const isNativeInputEvent = Schema.is(NativeInputEventSchema)
const isVoiceSnapshot = Schema.is(VoiceSnapshotSchema)

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

ipcRenderer.on(IPC.mediaRemoteVideoSessionReset, (_event, metadata) => {
  window.postMessage(
    { type: 'syrnike-native-video-session-reset', metadata },
    window.location.origin,
  )
})

ipcRenderer.on(IPC.mediaNativeVideoPresentationReset, (_event, metadata) => {
  window.postMessage(
    { type: 'syrnike-native-video-presentation-reset', metadata },
    window.location.origin,
  )
})

for (const state of ['available', 'unavailable'] as const) {
  ipcRenderer.on(
    `syrnike-desktop:media:remote-video-publication-${state}`,
    (_event, metadata) => {
      window.postMessage(
        { type: `syrnike-native-video-publication-${state}`, metadata },
        window.location.origin,
      )
    },
  )
}

ipcRenderer.on(IPC.mediaRemoteVideoFailed, (_event, metadata) => {
  window.postMessage(
    { type: 'syrnike-native-video-publication-failed', metadata },
    window.location.origin,
  )
})

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
    return invokeDecoded(IPC.versions, DesktopVersionsSchema)
  },
  clipboard: {
    writeText(text: string) {
      return invokeDecoded(IPC.clipboardWriteText, Schema.Void, text)
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
      return invokeDecoded(IPC.windowIsMaximized, Schema.Boolean)
    },
    getPreferences() {
      return invokeDecoded(
        IPC.windowGetPreferences,
        DesktopWindowPreferencesSchema,
      )
    },
    setCloseToTray(closeToTray: boolean) {
      return invokeDecoded(
        IPC.windowSetCloseToTray,
        DesktopWindowPreferencesSchema,
        closeToTray,
      )
    },
    setOpenAtLogin(openAtLogin: boolean) {
      return invokeDecoded(
        IPC.windowSetOpenAtLogin,
        DesktopWindowPreferencesSchema,
        openAtLogin,
      )
    },
  },
  activity: {
    set(details) {
      return invokeDecoded(IPC.activitySet, Schema.Void, details)
    },
    clear() {
      return invokeDecoded(IPC.activityClear, Schema.Void)
    },
  },
  tray: {
    setVoiceState(state: DesktopTrayVoiceState) {
      return invokeDecoded(IPC.traySetVoiceState, Schema.Void, state)
    },
  },
  voice: {
    dispatch(command: VoiceCommand) {
      return invokeDecoded(IPC.voiceDispatch, VoiceSnapshotSchema, command)
    },
    getSnapshot() {
      return invokeDecoded(IPC.voiceGetSnapshot, VoiceSnapshotSchema)
    },
    getTelemetry(): Promise<VoiceRtcTelemetrySnapshot | null> {
      return invokeDecoded(
        IPC.voiceGetTelemetry,
        Schema.Union([Schema.Null, VoiceRtcTelemetrySnapshotSchema]),
      )
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
      return invokeDecoded(IPC.authLoadSession, StoredSessionResultSchema)
    },
    saveSession(session: DesktopStoredSession) {
      return invokeDecoded(IPC.authSaveSession, Schema.Void, session)
    },
    clearSession() {
      return invokeDecoded(IPC.authClearSession, Schema.Void)
    },
  },
  settings: {
    load() {
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => ipcRenderer.invoke(IPC.settingsLoad),
          catch: (cause) => cause,
        }).pipe(Effect.map(normalizeDesktopLocalSettings)),
      )
    },
    update(patch: DesktopLocalSettingsPatch) {
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => ipcRenderer.invoke(IPC.settingsUpdate, patch),
          catch: (cause) => cause,
        }).pipe(Effect.map(normalizeDesktopLocalSettings)),
      )
    },
  },
  diagnostics: {
    createBundle(rendererJsonl: string) {
      return invokeDecoded(
        IPC.diagnosticsCreateBundle,
        Schema.Uint8Array,
        rendererJsonl,
      )
    },
    enqueueIncident(accountId: string, incident: RendererDiagnosticIncident) {
      return invokeDecoded(
        IPC.diagnosticsEnqueueIncident,
        Schema.Boolean,
        accountId,
        incident,
      )
    },
    leaseNativeIncidents(accountId: string) {
      return invokeDecoded(
        IPC.diagnosticsLeaseNativeIncidents,
        NativeIncidentLeaseSchema,
        accountId,
      )
    },
    acknowledgeNativeIncidents(accountId: string, batchId: string) {
      return invokeDecoded(
        IPC.diagnosticsAcknowledgeNativeIncidents,
        Schema.Boolean,
        accountId,
        batchId,
      )
    },
    releaseNativeIncidents(accountId: string, batchId: string) {
      return invokeDecoded(
        IPC.diagnosticsReleaseNativeIncidents,
        Schema.Boolean,
        accountId,
        batchId,
      )
    },
  },
  updates: {
    getState() {
      return invokeDecoded(IPC.updatesGetState, DesktopUpdateStateSchema)
    },
    check() {
      return invokeDecoded(IPC.updatesCheck, DesktopUpdateStateSchema)
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
      return invokeDecoded(IPC.hotkeysGetBindings, HotkeyBindingsSchema)
    },
    setBindings(bindings: HotkeyBinding[]) {
      return invokeDecoded(
        IPC.hotkeysSetBindings,
        HotkeyRegistrationResultsSchema,
        bindings,
      )
    },
    setSuspended(suspended: boolean) {
      return invokeDecoded(IPC.hotkeysSetSuspended, Schema.Void, suspended)
    },
    startRecording() {
      return invokeDecoded(IPC.hotkeysStartRecording, Schema.Void)
    },
    stopRecording() {
      return invokeDecoded(IPC.hotkeysStopRecording, Schema.Void)
    },
    getRuntimeStatus() {
      return invokeDecoded(
        IPC.hotkeysGetRuntimeStatus,
        HotkeyRuntimeStatusSchema,
      )
    },
    onRecordedInput(handler: (event: NativeInputEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => {
        if (isNativeInputEvent(input)) handler(input)
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
      return invokeDecoded(IPC.overlayGetState, DesktopOverlayStateSchema)
    },
    setEnabled(enabled: boolean) {
      return invokeDecoded(
        IPC.overlaySetEnabled,
        DesktopOverlayStateSchema,
        enabled,
      )
    },
    setSnapshot(snapshot: DesktopOverlaySnapshot) {
      return invokeDecoded(
        IPC.overlaySetSnapshot,
        DesktopOverlayStateSchema,
        snapshot,
      )
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
    getRuntimeState() {
      return invokeNativeMediaRuntimeState(IPC.mediaGetRuntimeState)
    },
    retryRuntime() {
      return invokeNativeMediaRuntimeState(IPC.mediaRetryRuntime)
    },
    getDisplaySources(requestId: string) {
      return invokeDecoded(
        IPC.mediaGetDisplaySources,
        DesktopDisplayMediaSourcesSchema,
        requestId,
      )
    },
    selectDisplaySource(
      requestId: string,
      sourceId: string,
      audioRequested?: boolean,
    ) {
      return invokeDecoded(
        IPC.mediaSelectDisplaySource,
        Schema.Boolean,
        requestId,
        sourceId,
        audioRequested,
      )
    },
    cancelRequest(requestId: string) {
      return invokeDecoded(IPC.mediaCancelRequest, Schema.Void, requestId)
    },
    openDisplayPicker(audioRequested: boolean) {
      return invokeDecoded(
        IPC.mediaOpenDisplayPicker,
        DesktopDisplayMediaRequestSchema,
        audioRequested,
      )
    },
    listDevices(kind: 'audioinput' | 'audiooutput' | 'videoinput') {
      return invokeDecoded(
        IPC.mediaListDevices,
        NativeMediaDevicesSchema,
        kind,
      )
    },
    startMicrophonePreview() {
      return invokeDecoded(IPC.mediaStartMicrophonePreview, Schema.Void)
    },
    stopMicrophonePreview() {
      return invokeDecoded(IPC.mediaStopMicrophonePreview, Schema.Void)
    },
    setRemoteVideoDemand(sessionId, generation, trackId, demanded) {
      return invokeDecoded(
        IPC.mediaSetRemoteVideoDemand,
        Schema.Void,
        sessionId,
        generation,
        trackId,
        demanded,
      )
    },
    replayRemoteVideoPublications() {
      return invokeDecoded(
        IPC.mediaReplayRemoteVideoPublications,
        Schema.Void,
      )
    },
    setLocalScreenPreviewDemand(demand) {
      return invokeDecoded(
        IPC.mediaSetLocalScreenPreviewDemand,
        Schema.Void,
        demand,
      )
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
    onRuntimeState(handler: (state: NativeMediaRuntimeState) => void) {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isNativeMediaRuntimeState(payload)) handler(payload)
      }
      ipcRenderer.on(IPC.mediaRuntimeStateChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.mediaRuntimeStateChanged, listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('syrnikeDesktop', syrnikeDesktop)
