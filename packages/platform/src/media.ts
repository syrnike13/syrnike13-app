import { Option, Schema } from 'effect'

type Mutable<Type> = Type extends ReadonlyArray<infer Item>
  ? Array<Mutable<Item>>
  : Type extends object
    ? { -readonly [Key in keyof Type]: Mutable<Type[Key]> }
    : Type

/** Метод hybrid media engine (счётчики как в Discord RTC debug). */
export type NativeMediaFrameMethod =
  | 'wgc_gpu'
  | 'dxgi_gpu'

export type NativeMediaFrameStats = Record<NativeMediaFrameMethod, number>

export type NativeMediaEncoderBackend = 'mf_h264_d3d11'

/** process/system_exclude = звук демонстрации; microphone = входной голос; none = звук недоступен. */
export type NativeMediaAudioMode =
  | 'process'
  | 'system_exclude'
  | 'microphone'
  | 'none'

export type NativeMediaScreenAudioMode = Exclude<
  NativeMediaAudioMode,
  'microphone'
>

export type NativeMediaLoopbackMode =
  | 'include_target_process_tree'
  | 'exclude_target_process_tree'

export type NativeMediaEchoCancellationMode =
  | 'disabled'
  | 'software'
  | 'unavailable'

export type NativeMediaNoiseSuppressionMode =
  | 'disabled'
  | 'software'
  | 'unavailable'

export type NativeMediaTarget = {
  sourceId: string
}

export type NativeMediaSessionKind = 'screen' | 'microphone'

export const NativeMediaDeviceInfoSchema = Schema.Struct({
  deviceId: Schema.String,
  kind: Schema.Literals(['audioinput', 'audiooutput', 'videoinput']),
  label: Schema.String,
})

export type NativeMediaDeviceInfo = typeof NativeMediaDeviceInfoSchema.Type

const MediaIdentifierSchema = (maximumLength: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumLength),
  )

const MediaIntegerSchema = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

export const LiveKitNativePublisherCredentialsSchema = Schema.Struct({
  url: MediaIdentifierSchema(2_048).check(
    Schema.makeFilter((value) => {
      try {
        const protocol = new URL(value).protocol
        return protocol === 'ws:' || protocol === 'wss:'
      } catch {
        return false
      }
    }, { expected: 'a WebSocket URL' }),
  ),
  token: MediaIdentifierSchema(32_768),
  participantIdentity: MediaIdentifierSchema(512),
})

export const ScreenSourceSpecSchema = Schema.Struct({
  sourceId: MediaIdentifierSchema(2_048),
  width: MediaIntegerSchema(64, 7_680),
  height: MediaIntegerSchema(64, 4_320),
  fps: MediaIntegerSchema(1, 240),
  bitrate: MediaIntegerSchema(32_000, 100_000_000),
  audioBitrate: MediaIntegerSchema(6_000, 512_000),
  audioRequested: Schema.Boolean,
})

export type LiveKitNativePublisherCredentials =
  typeof LiveKitNativePublisherCredentialsSchema.Type

export type ScreenSourceSpec = typeof ScreenSourceSpecSchema.Type

export type NativeMediaScreenSessionStartOptions = {
  kind: 'screen'
  requestId: string
  sourceId: string
  width: number
  height: number
  fps: number
  bitrate: number
  audioBitrate?: number
  audio?: {
    requested: boolean
  }
  participantIdentity: string
}

export type NativeMediaScreenSessionPrepareOptions = {
  participantIdentity: string
}

export type NativeMediaMicrophoneSessionStartOptions = {
  kind: 'microphone'
  requestId: string
  audioBitrate?: number
  muted?: boolean
  participantIdentity: string
}

export type NativeMicrophonePipelineConfig = {
  /** Explicit capture device, or null to follow the Windows default device. */
  deviceId: string | null
  bypassSystemAudioInputProcessing: boolean
  automaticGainControl: boolean
  noiseSuppression: boolean
  echoCancellation: boolean
  inputVolume: number
  voiceGateEnabled: boolean
  voiceGateThresholdDb: number
  voiceGateAutoThreshold: boolean
}

export type NativeMediaSessionStartOptions =
  | NativeMediaScreenSessionStartOptions
  | NativeMediaMicrophoneSessionStartOptions

export type NativeMediaScreenSession = {
  kind: 'screen'
  sessionId: string
  encoder: NativeMediaEncoderBackend
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  audio?: {
    mode: NativeMediaScreenAudioMode
    targetProcessId?: number
    loopbackMode?: NativeMediaLoopbackMode
  }
  nativeParticipantIdentity?: string
}

export type NativeMediaMicrophoneSession = {
  kind: 'microphone'
  sessionId: string
  audio: {
    mode: 'microphone'
    sampleRate: 48_000
    channels: 1
    noiseSuppression: NativeMediaNoiseSuppressionMode
    echoCancellation: NativeMediaEchoCancellationMode
  }
  nativeParticipantIdentity: string
}

export type NativeMediaSession =
  | NativeMediaScreenSession
  | NativeMediaMicrophoneSession

export type NativeMediaSessionStatus =
  | { status: 'idle' }
  | { status: 'starting' }
  | {
      status: 'running'
      sessionId: string
      width?: number
      height?: number
      fps?: number
      bitrate?: number
    }
  | { status: 'error'; message: string }

export type NativeMediaEngineCapabilities = {
  screen: boolean
  systemAudio: boolean
  microphone: boolean
  camera: boolean
}

type NativeMediaEngineSessionSummaryBase = {
  sessionId: string
  status: 'starting' | 'running' | 'error'
  width?: number
  height?: number
  fps?: number
  bitrate?: number
}

export type NativeMediaScreenEngineSessionSummary =
  NativeMediaEngineSessionSummaryBase & {
    kind: 'screen'
    audio?: {
      mode: NativeMediaScreenAudioMode
      targetProcessId?: number
      loopbackMode?: NativeMediaLoopbackMode
    }
  }

export type NativeMediaMicrophoneEngineSessionSummary =
  NativeMediaEngineSessionSummaryBase & {
    kind: 'microphone'
    audio?: {
      mode: 'microphone'
      sampleRate?: 48_000
      channels?: 1 | 2
      noiseSuppression?: NativeMediaNoiseSuppressionMode
      echoCancellation?: NativeMediaEchoCancellationMode
    }
  }

export type NativeMediaEngineSessionSummary =
  | NativeMediaScreenEngineSessionSummary
  | NativeMediaMicrophoneEngineSessionSummary

export type NativeMediaEngineSnapshot = {
  available: boolean
  runtime: {
    available: boolean
    status: 'stopped' | 'starting' | 'ready' | 'recovering' | 'degraded'
    pid?: number
    restartCount: number
    degradedReason?: string
  }
  capabilities: NativeMediaEngineCapabilities
  activeSessions: NativeMediaEngineSessionSummary[]
  lastError: string | null
}

export type NativeMediaState = NativeMediaSessionStatus & {
  engine: NativeMediaEngineSnapshot
}

export type NativeMediaStatsEvent = {
  sessionId: string
  methods: NativeMediaFrameStats
  activeMethod?: NativeMediaFrameMethod
  publishedVideo?: boolean
  publishedAudio?: boolean
  audioFrames?: number
  audioPackets?: number
  audioBacklogPackets?: number
  audioDiscontinuities?: number
  audioPeakDb?: number
  audioRmsDb?: number
  videoFrames?: number
  videoIntervalFrames?: number
  videoLateFrames?: number
  videoNoFrameCount?: number
  videoRepeatedFrameCount?: number
  videoRecoverableLostCount?: number
  videoGpuPoolSlotsAvailable?: number
  videoGpuPoolSlotsTotal?: number
  videoDxgiDuplicationHoldUsMax?: number
  videoSourceUpdates?: number
  videoGpuSubmissions?: number
  videoIdleRefreshes?: number
  videoCoalescedSourceUpdates?: number
  videoEncoderBackpressureTicks?: number
  videoSupersededReadyFrames?: number
  videoGpuSlotTimeouts?: number
  videoGpuSlotsRecovered?: number
  videoGpuFramesDroppedStale?: number
  videoGpuPoolRollovers?: number
  videoGpuRolloversBlocked?: number
  videoGpuRetiredGenerations?: number
  videoGpuSlotsQuarantined?: number
  videoPreviewBridgeSubmissions?: number
  videoPreviewBridgeAcquires?: number
  videoPreviewBridgeTimeouts?: number
  videoPreviewBridgeSlotsRecovered?: number
  videoPreviewGpuSubmissions?: number
  videoPreviewFramesCompleted?: number
  videoPreviewSlotTimeouts?: number
  videoPreviewFramesDroppedStale?: number
  videoPreviewDeviceResets?: number
  videoGpuCompletionP50Us?: number
  videoGpuCompletionP95Us?: number
  videoGpuCompletionMaxUs?: number
  videoAvgCaptureUs?: number
  videoAvgReadbackUs?: number
  videoAvgScaleUs?: number
  videoAvgPublishUs?: number
  videoSourceWidth?: number
  videoSourceHeight?: number
  videoContentWidth?: number
  videoContentHeight?: number
  captureThreadMmcss?: boolean
  rtpStatsAvailable?: boolean
  rtpPacketsSent?: number
  rtpBytesSent?: number
  rtpFramesSent?: number
  rtpFramesEncoded?: number
  encoderImplementation?: string
}

export const NativeMicrophoneMetricsEventSchema = Schema.Struct({
  revision: Schema.Natural,
  inputDb: Schema.Finite,
  thresholdDb: Schema.Finite,
  open: Schema.Boolean,
})

export type NativeMicrophoneMetricsEvent =
  Mutable<typeof NativeMicrophoneMetricsEventSchema.Type>

export const NativeMicrophonePreviewStateEventSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('running') }),
  Schema.Struct({ status: Schema.Literal('stopped') }),
  Schema.Struct({
    status: Schema.Literal('error'),
    message: Schema.String,
  }),
])

export type NativeMicrophonePreviewStateEvent =
  Mutable<typeof NativeMicrophonePreviewStateEventSchema.Type>

const NativeMediaUnavailableFailureSchema = Schema.Struct({
  code: Schema.Literal('native_media_unavailable'),
  message: Schema.String.check(Schema.isMaxLength(4_096)),
  retryable: Schema.Literal(false),
  stage: Schema.Literal('native_runtime'),
})

export const NativeMediaRuntimeStateSchema = Schema.Struct({
  available: Schema.Literal(false),
  status: Schema.Literal('unavailable'),
  restartCount: Schema.Literal(0),
  failure: NativeMediaUnavailableFailureSchema,
})

export type NativeMediaRuntimeState = typeof NativeMediaRuntimeStateSchema.Type

export type NativeMediaStateEvent = NativeMediaSessionStatus & {
  sessionId?: string
  deviceId?: string
  message?: string
  audio?: {
    mode: NativeMediaAudioMode
    sampleRate?: 48_000
    channels?: 1 | 2
    noiseSuppression?: NativeMediaNoiseSuppressionMode
    echoCancellation?: NativeMediaEchoCancellationMode
    targetProcessId?: number
    loopbackMode?: NativeMediaLoopbackMode
  }
}

export type NativeMediaRuntimeLostEvent = {
  sessionId: string
  reason: 'exit' | 'stream_error' | 'circuit_open' | 'handshake_failed'
  message: string
  recovering: boolean
}

export function assertLiveKitNativePublisherCredentials(
  value: unknown,
): asserts value is LiveKitNativePublisherCredentials {
  if (
    Option.isNone(
      Schema.decodeUnknownOption(LiveKitNativePublisherCredentialsSchema)(
        value,
      ),
    )
  ) {
    throw new TypeError('Invalid LiveKitNativePublisherCredentials')
  }
}

export function isLiveKitNativePublisherCredentials(
  value: unknown,
): value is LiveKitNativePublisherCredentials {
  return Option.isSome(
    Schema.decodeUnknownOption(LiveKitNativePublisherCredentialsSchema)(value),
  )
}

export function parseLiveKitNativePublisherCredentials(
  value: unknown,
): LiveKitNativePublisherCredentials {
  const decoded = Schema.decodeUnknownOption(
    LiveKitNativePublisherCredentialsSchema,
  )(value)
  if (Option.isNone(decoded)) {
    throw new TypeError('Invalid LiveKitNativePublisherCredentials')
  }
  return decoded.value
}

export function assertScreenSourceSpec(
  value: unknown,
): asserts value is ScreenSourceSpec {
  if (
    Option.isNone(
      Schema.decodeUnknownOption(ScreenSourceSpecSchema)(value),
    )
  ) {
    throw new TypeError('Invalid ScreenSourceSpec')
  }
}

export function isScreenSourceSpec(value: unknown): value is ScreenSourceSpec {
  return Option.isSome(
    Schema.decodeUnknownOption(ScreenSourceSpecSchema)(value),
  )
}

export function isNativeMediaRuntimeState(
  value: unknown,
): value is NativeMediaRuntimeState {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeMediaRuntimeStateSchema)(value),
  )
}

export function parseScreenSourceSpec(value: unknown): ScreenSourceSpec {
  const decoded = Schema.decodeUnknownOption(ScreenSourceSpecSchema)(value)
  if (Option.isNone(decoded)) {
    throw new TypeError('Invalid ScreenSourceSpec')
  }
  return decoded.value
}
