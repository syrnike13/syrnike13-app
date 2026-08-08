import { Schema } from 'effect'

import type {
  NativeMediaDeviceInfo,
  NativeMediaRuntimeState,
  NativeMicrophoneMetricsEvent,
  NativeMicrophonePreviewStateEvent,
} from './media'
import type {
  DesktopOverlaySnapshot,
  DesktopOverlayState,
} from './overlay'
import type {
  NativeDiagnosticIncidentBatch,
  RendererDiagnosticIncident,
} from './diagnostics'
import type { DesktopLocalSettings, DesktopLocalSettingsPatch } from './settings'
import type { VoiceCommand, VoiceSnapshot } from './voice/voice-types'
import type { VoiceRtcTelemetrySnapshot } from './voice/voice-telemetry'

type Mutable<Type> = Type extends ReadonlyArray<infer Item>
  ? Array<Mutable<Item>>
  : Type extends object
    ? { -readonly [Key in keyof Type]: Mutable<Type[Key]> }
    : Type

/** Где выполняется UI: браузер или оболочка Electron. */
export type SyrnikeRuntime = 'web' | 'desktop'

/** ОС настольной оболочки (совпадает с Node `process.platform`). */
export type DesktopOs = 'darwin' | 'win32' | 'linux'

export interface DesktopPlatformInfo {
  os: DesktopOs
}

export const DesktopVersionsSchema = Schema.Struct({
  app: Schema.String,
  electron: Schema.String,
  chrome: Schema.String,
  node: Schema.String,
})

export type DesktopVersions = Mutable<typeof DesktopVersionsSchema.Type>

export const ActivityDetailsSchema = Schema.Struct({
  type: Schema.Literals(['playing', 'listening', 'watching']),
  name: Schema.String,
  details: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
})

export type ActivityDetails = Mutable<typeof ActivityDetailsSchema.Type>

export const DesktopWindowPreferencesSchema = Schema.Struct({
  closeToTray: Schema.Boolean,
  openAtLogin: Schema.Boolean,
})

export type DesktopWindowPreferences = Mutable<
  typeof DesktopWindowPreferencesSchema.Type
>

export const DesktopTrayVoiceStateSchema = Schema.Literals([
  'default',
  'voice-idle',
  'voice-speaking',
  'voice-muted',
  'voice-deafened',
])

export type DesktopTrayVoiceState =
  typeof DesktopTrayVoiceStateSchema.Type

const DesktopSessionIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
)

export const DesktopStoredSessionSchema = Schema.Struct({
  _id: DesktopSessionIdentifierSchema,
  token: DesktopSessionIdentifierSchema,
  user_id: DesktopSessionIdentifierSchema,
})

export type DesktopStoredSession = typeof DesktopStoredSessionSchema.Type

export const DesktopUpdateStateSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('idle') }),
  Schema.Struct({ status: Schema.Literal('checking') }),
  Schema.Struct({
    status: Schema.Literal('available'),
    version: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal('downloading'),
    percent: Schema.Finite,
  }),
  Schema.Struct({ status: Schema.Literal('ready'), version: Schema.String }),
  Schema.Struct({
    status: Schema.Literal('installing'),
    version: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String }),
])

export type DesktopUpdateState = Mutable<typeof DesktopUpdateStateSchema.Type>

export const HotkeyActionSchema = Schema.Literals([
  'toggle-mic',
  'toggle-deafen',
  'toggle-camera',
  'toggle-screen-share',
  'return-to-voice',
  'disconnect-voice',
  'navigate-back',
  'navigate-forward',
  'push-to-talk',
  'push-to-mute',
  'priority-push-to-talk',
  'toggle-vad',
])

export type HotkeyAction = typeof HotkeyActionSchema.Type

export const HotkeyComboSchema = Schema.Struct({
  codes: Schema.mutable(Schema.Array(Schema.String)),
})

export type HotkeyCombo = Mutable<typeof HotkeyComboSchema.Type>

export const HotkeyBindingSchema = Schema.Struct({
  id: Schema.String,
  action: HotkeyActionSchema,
  combo: Schema.Union([HotkeyComboSchema, Schema.Null]),
  enabled: Schema.Boolean,
})

export type HotkeyBinding = Mutable<typeof HotkeyBindingSchema.Type>

export const HotkeyRegistrationStatusSchema = Schema.Literals([
  'registered',
  'disabled',
  'invalid',
  'taken',
  'unsupported',
])

export type HotkeyRegistrationStatus =
  typeof HotkeyRegistrationStatusSchema.Type

export const NativeInputEventSchema = Schema.Struct({
  type: Schema.Literals(['inputDown', 'inputUp']),
  source: Schema.Literals(['keyboard', 'mouse']),
  code: Schema.String,
  label: Schema.String,
  pressedCodes: Schema.mutable(Schema.Array(Schema.String)),
})

export type NativeInputEvent = Mutable<typeof NativeInputEventSchema.Type>

export const HotkeyRuntimeStatusSchema = Schema.Literals([
  'running',
  'not-running',
  'unsupported-platform',
  'permission-required',
])

export type HotkeyRuntimeStatus = typeof HotkeyRuntimeStatusSchema.Type

export const HotkeyRegistrationResultSchema = Schema.Struct({
  id: Schema.String,
  status: HotkeyRegistrationStatusSchema,
})

export type HotkeyRegistrationResult =
  Mutable<typeof HotkeyRegistrationResultSchema.Type>

export const HotkeyActivationEventSchema = Schema.Struct({
  action: HotkeyActionSchema,
  phase: Schema.Literals(['pressed', 'released']),
})

export type HotkeyActivationEvent = Mutable<
  typeof HotkeyActivationEventSchema.Type
>

export type DesktopDisplayMediaSourceType = 'screen' | 'window' | 'game'

export const DesktopDisplayMediaSourceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Literals(['screen', 'window', 'game']),
  thumbnailDataUrl: Schema.Union([Schema.String, Schema.Null]),
  appIconDataUrl: Schema.Union([Schema.String, Schema.Null]),
  processId: Schema.optional(Schema.Int),
  processPath: Schema.optional(Schema.String),
  classification: Schema.optional(Schema.String),
  audioAvailable: Schema.optional(Schema.Boolean),
  audioMode: Schema.optional(
    Schema.Literals(['system_exclude', 'process', 'none']),
  ),
})

export type DesktopDisplayMediaSource =
  typeof DesktopDisplayMediaSourceSchema.Type

export const DesktopDisplayMediaRequestSchema = Schema.Struct({
  id: Schema.String,
  audioRequested: Schema.Boolean,
  /** Видео идёт через native runtime, не через desktopCapturer. */
  nativeVideo: Schema.optionalKey(Schema.Boolean),
})

export type DesktopDisplayMediaRequest =
  Mutable<typeof DesktopDisplayMediaRequestSchema.Type>

export const DesktopDisplayMediaSelectionSchema = Schema.Struct({
  requestId: Schema.String,
  sourceId: Schema.String,
  audioRequested: Schema.Boolean,
})

export type DesktopDisplayMediaSelection =
  Mutable<typeof DesktopDisplayMediaSelectionSchema.Type>

export const NativeMediaDeviceKindSchema = Schema.Literals([
  'audioinput',
  'audiooutput',
  'videoinput',
])

export type NativeMediaDeviceKind = typeof NativeMediaDeviceKindSchema.Type

const NativeMediaDemandIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
)
const NativeMediaGenerationSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
)

export const RemoteVideoDemandSchema = Schema.Struct({
  sessionId: NativeMediaDemandIdentifierSchema,
  generation: NativeMediaGenerationSchema,
  trackId: NativeMediaDemandIdentifierSchema,
  demanded: Schema.Boolean,
})

export type RemoteVideoDemand = Mutable<
  typeof RemoteVideoDemandSchema.Type
>

export const LocalScreenPreviewDemandSchema = Schema.Struct({
  demanded: Schema.Boolean,
  width: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(16),
    Schema.isLessThanOrEqualTo(3_840),
  ),
  height: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(16),
    Schema.isLessThanOrEqualTo(2_160),
  ),
  fps: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(60),
  ),
})

export type LocalScreenPreviewDemand = Mutable<
  typeof LocalScreenPreviewDemandSchema.Type
>

export type {
  NativeMediaEncoderBackend,
  LiveKitNativePublisherCredentials,
  NativeMediaDeviceInfo,
  NativeMediaFrameMethod,
  NativeMediaFrameStats,
  NativeMediaLoopbackMode,
  NativeMicrophonePipelineConfig,
  NativeMicrophonePreviewStateEvent,
  NativeMediaTarget,
  ScreenSourceSpec,
} from './media'

/**
 * API, который preload пробрасывает в `window.syrnikeDesktop`.
 * Расширяйте по мере появления нативных возможностей (presence, screen share, …).
 */
export interface SyrnikeDesktopApi {
  readonly runtime: 'desktop'
  readonly platform: DesktopPlatformInfo
  getVersions(): Promise<DesktopVersions>
  clipboard: {
    writeText(text: string): Promise<void>
  }
  window: {
    minimize(): void
    maximize(): void
    close(): void
    show(): void
    isMaximized(): Promise<boolean>
    getPreferences(): Promise<DesktopWindowPreferences>
    setCloseToTray(closeToTray: boolean): Promise<DesktopWindowPreferences>
    setOpenAtLogin(openAtLogin: boolean): Promise<DesktopWindowPreferences>
  }
  activity: {
    set(details: ActivityDetails | null): Promise<void>
    clear(): Promise<void>
  }
  tray: {
    setVoiceState(state: DesktopTrayVoiceState): Promise<void>
  }
  voice: {
    dispatch(command: VoiceCommand): Promise<VoiceSnapshot>
    getSnapshot(): Promise<VoiceSnapshot>
    getTelemetry(): Promise<VoiceRtcTelemetrySnapshot | null>
    onSnapshot(handler: (snapshot: VoiceSnapshot) => void): () => void
  }
  auth: {
    loadSession(): Promise<DesktopStoredSession | null>
    saveSession(session: DesktopStoredSession): Promise<void>
    clearSession(): Promise<void>
  }
  settings: {
    load(): Promise<DesktopLocalSettings>
    update(patch: DesktopLocalSettingsPatch): Promise<DesktopLocalSettings>
  }
  diagnostics: {
    createBundle(rendererJsonl: string): Promise<Uint8Array>
    enqueueIncident(
      accountId: string,
      incident: RendererDiagnosticIncident,
    ): Promise<boolean>
    leaseNativeIncidents(accountId: string): Promise<NativeDiagnosticIncidentBatch | null>
    acknowledgeNativeIncidents(accountId: string, batchId: string): Promise<boolean>
    releaseNativeIncidents(accountId: string, batchId: string): Promise<boolean>
  }
  updates: {
    getState(): Promise<DesktopUpdateState>
    check(): Promise<DesktopUpdateState>
    install(): void
    onStateChange(handler: (state: DesktopUpdateState) => void): () => void
  }
  hotkeys: {
    getBindings(): Promise<HotkeyBinding[]>
    setBindings(
      bindings: HotkeyBinding[],
    ): Promise<HotkeyRegistrationResult[]>
    setSuspended(suspended: boolean): Promise<void>
    startRecording(): Promise<void>
    stopRecording(): Promise<void>
    getRuntimeStatus(): Promise<HotkeyRuntimeStatus>
    onRecordedInput(handler: (event: NativeInputEvent) => void): () => void
    onPressed(handler: (event: HotkeyActivationEvent) => void): () => void
  }
  overlay: {
    getState(): Promise<DesktopOverlayState>
    setEnabled(enabled: boolean): Promise<DesktopOverlayState>
    setSnapshot(snapshot: DesktopOverlaySnapshot): Promise<DesktopOverlayState>
    onStateChange(handler: (state: DesktopOverlayState) => void): () => void
  }
  media: {
    getRuntimeState(): Promise<NativeMediaRuntimeState>
    retryRuntime(): Promise<NativeMediaRuntimeState>
    getDisplaySources(requestId: string): Promise<DesktopDisplayMediaSource[]>
    selectDisplaySource(
      requestId: string,
      sourceId: string,
      audioRequested?: boolean,
    ): Promise<boolean>
    cancelRequest(requestId: string): Promise<void>
    openDisplayPicker(audioRequested: boolean): Promise<DesktopDisplayMediaRequest>
    listDevices(
      kind: NativeMediaDeviceKind,
    ): Promise<NativeMediaDeviceInfo[]>
    startMicrophonePreview(): Promise<void>
    stopMicrophonePreview(): Promise<void>
    setRemoteVideoDemand(
      sessionId: string,
      generation: number,
      trackId: string,
      demanded: boolean,
    ): Promise<void>
    replayRemoteVideoPublications(): Promise<void>
    setLocalScreenPreviewDemand(
      demand: LocalScreenPreviewDemand,
    ): Promise<void>
    onRequest(handler: (request: DesktopDisplayMediaRequest) => void): () => void
    onDisplayPickerResolved(
      handler: (payload: DesktopDisplayMediaSelection) => void,
    ): () => void
    onMicrophoneMetrics(
      handler: (event: NativeMicrophoneMetricsEvent) => void,
    ): () => void
    onMicrophonePreviewState(
      handler: (event: NativeMicrophonePreviewStateEvent) => void,
    ): () => void
    onRuntimeState(
      handler: (state: NativeMediaRuntimeState) => void,
    ): () => void
  }
}
