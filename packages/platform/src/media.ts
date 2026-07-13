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

export type NativeMediaDeviceInfo = {
  deviceId: string
  kind: 'audioinput' | 'audiooutput' | 'videoinput'
  label: string
}

export type NativeMediaLiveKitCredentials = {
  url: string
  token: string
  participantIdentity: string
}

export type LiveKitNativePublisherCredentials = Readonly<{
  url: string
  token: string
  participantIdentity: string
}>

export type ScreenSourceSpec = Readonly<{
  sourceId: string
  width: number
  height: number
  fps: number
  bitrate: number
  audioBitrate: number
  audioRequested: boolean
}>

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
  livekit: NativeMediaLiveKitCredentials
}

export type NativeMediaScreenSessionPrepareOptions = {
  livekit: NativeMediaLiveKitCredentials
}

export type NativeMediaMicrophoneSessionStartOptions = {
  kind: 'microphone'
  requestId: string
  audioBitrate?: number
  muted?: boolean
  livekit: NativeMediaLiveKitCredentials
}

export type NativeMicrophonePipelineConfig = {
  /** Explicit capture device, or null to follow the Windows default device. */
  deviceId: string | null
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
  audioPeakDb?: number
  audioRmsDb?: number
  videoFrames?: number
  videoIntervalFrames?: number
  videoLateFrames?: number
  videoNoFrameCount?: number
  videoRepeatedFrameCount?: number
  videoRecoverableLostCount?: number
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

export type NativeMicrophoneMetricsEvent = {
  inputDb: number
  thresholdDb: number
  open: boolean
}

export type NativeMicrophonePreviewStateEvent =
  | { status: 'running' }
  | { status: 'stopped' }
  | { status: 'error'; message: string }

export type NativeMediaStateEvent = NativeMediaSessionStatus & {
  sessionId?: string
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(
  value: unknown,
  maxLength = Number.MAX_SAFE_INTEGER,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength
  )
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function assertObjectRecord(
  value: unknown,
  context: string,
): asserts value is Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new TypeError(`${context} must be an object`)
  }
}

function assertNonEmptyString(
  value: unknown,
  context: string,
  maxLength = Number.MAX_SAFE_INTEGER,
): asserts value is string {
  if (!isNonEmptyString(value, maxLength)) {
    throw new TypeError(
      `${context} must be a non-empty string no longer than ${maxLength} characters`,
    )
  }
}

function assertIntegerInRange(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!isIntegerInRange(value, minimum, maximum)) {
    throw new TypeError(
      `${context} must be an integer between ${minimum} and ${maximum}`,
    )
  }
}

function assertBoolean(value: unknown, context: string): asserts value is boolean {
  if (!isBoolean(value)) {
    throw new TypeError(`${context} must be a boolean`)
  }
}

export function assertLiveKitNativePublisherCredentials(
  value: unknown,
): asserts value is LiveKitNativePublisherCredentials {
  assertObjectRecord(value, 'LiveKitNativePublisherCredentials')
  assertNonEmptyString(value.url, 'LiveKitNativePublisherCredentials.url', 2_048)
  try {
    const protocol = new URL(value.url).protocol
    if (protocol !== 'ws:' && protocol !== 'wss:') {
      throw new TypeError(
        'LiveKitNativePublisherCredentials.url must use ws: or wss:',
      )
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('must use')) {
      throw error
    }
    throw new TypeError('LiveKitNativePublisherCredentials.url must be a valid URL')
  }
  assertNonEmptyString(
    value.token,
    'LiveKitNativePublisherCredentials.token',
    32_768,
  )
  assertNonEmptyString(
    value.participantIdentity,
    'LiveKitNativePublisherCredentials.participantIdentity',
    512,
  )
}

export function isLiveKitNativePublisherCredentials(
  value: unknown,
): value is LiveKitNativePublisherCredentials {
  try {
    assertLiveKitNativePublisherCredentials(value)
    return true
  } catch {
    return false
  }
}

export function parseLiveKitNativePublisherCredentials(
  value: unknown,
): LiveKitNativePublisherCredentials {
  assertLiveKitNativePublisherCredentials(value)
  return value
}

export function assertScreenSourceSpec(
  value: unknown,
): asserts value is ScreenSourceSpec {
  assertObjectRecord(value, 'ScreenSourceSpec')
  assertNonEmptyString(value.sourceId, 'ScreenSourceSpec.sourceId', 2_048)
  assertIntegerInRange(value.width, 'ScreenSourceSpec.width', 64, 7_680)
  assertIntegerInRange(value.height, 'ScreenSourceSpec.height', 64, 4_320)
  assertIntegerInRange(value.fps, 'ScreenSourceSpec.fps', 1, 240)
  assertIntegerInRange(
    value.bitrate,
    'ScreenSourceSpec.bitrate',
    32_000,
    100_000_000,
  )
  assertIntegerInRange(
    value.audioBitrate,
    'ScreenSourceSpec.audioBitrate',
    6_000,
    512_000,
  )
  assertBoolean(value.audioRequested, 'ScreenSourceSpec.audioRequested')
}

export function isScreenSourceSpec(value: unknown): value is ScreenSourceSpec {
  try {
    assertScreenSourceSpec(value)
    return true
  } catch {
    return false
  }
}

export function parseScreenSourceSpec(value: unknown): ScreenSourceSpec {
  assertScreenSourceSpec(value)
  return value
}
