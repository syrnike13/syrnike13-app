/** Метод hybrid media engine (счётчики как в Discord RTC debug). */
export type NativeMediaFrameMethod =
  | 'wgc'
  | 'dxgi'
  | 'gdi_blt'

export type NativeMediaFrameStats = Record<NativeMediaFrameMethod, number>

export type NativeMediaEncoderBackend = 'webrtc'

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
  kind: 'audioinput'
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

export type LocalMediaIntent = Readonly<{
  operationId: string | null
  envelopeRevision: number
  microphone: LocalMediaIntentMicrophone
  screen: LocalMediaIntentScreen
}>

export type LocalMediaIntentMicrophone =
  | Readonly<{
      revision: number
      state: 'off'
    }>
  | Readonly<{
      revision: number
      state: 'retain'
      muted: boolean
    }>
  | Readonly<{
      revision: number
      state: 'publish'
      credentials: LiveKitNativePublisherCredentials
      muted: boolean
      audioBitrateKbps: number
    }>

export type LocalMediaIntentScreen =
  | Readonly<{
      revision: number
      state: 'off'
    }>
  | Readonly<{
      revision: number
      state: 'prepare' | 'publish'
      credentials: LiveKitNativePublisherCredentials
      source: ScreenSourceSpec
    }>

export type LocalMediaIntentAcceptanceResult = Readonly<{
  operationId: string | null
  acceptedEnvelopeRevision: number
  disposition: 'accepted' | 'duplicate'
}>

export type LocalMediaObservedStateEvent =
  | Readonly<{
      kind: 'microphone'
      operationId: string | null
      revision: number
      reconcileAttempt: number
      sequence: number
      state: 'off' | 'retained' | 'publishing' | 'published' | 'stopping'
      muted: boolean
      audioBitrateKbps: number | null
      participantIdentity: string | null
    }>
  | Readonly<{
      kind: 'microphone'
      operationId: string | null
      revision: number
      reconcileAttempt: number
      sequence: number
      state: 'error'
      muted: boolean
      audioBitrateKbps: number | null
      participantIdentity: string | null
      errorCode: string
      errorMessage: string
      errorStage: string
      retryable: boolean
    }>
  | Readonly<{
      kind: 'screen'
      operationId: string | null
      revision: number
      reconcileAttempt: number
      sequence: number
      state:
        | 'off'
        | 'preparing'
        | 'prepared'
        | 'publishing'
        | 'published'
        | 'stopping'
      source: ScreenSourceSpec | null
      participantIdentity: string | null
    }>
  | Readonly<{
      kind: 'screen'
      operationId: string | null
      revision: number
      reconcileAttempt: number
      sequence: number
      state: 'error'
      source: ScreenSourceSpec | null
      participantIdentity: string | null
      errorCode: string
      errorMessage: string
      errorStage: string
      retryable: boolean
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

function isOptionalNonEmptyString(
  value: unknown,
  maxLength = Number.MAX_SAFE_INTEGER,
): value is string | null {
  return value === null || isNonEmptyString(value, maxLength)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
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

function assertOptionalNonEmptyString(
  value: unknown,
  context: string,
  maxLength = Number.MAX_SAFE_INTEGER,
): asserts value is string | null {
  if (!isOptionalNonEmptyString(value, maxLength)) {
    throw new TypeError(
      `${context} must be a non-empty string no longer than ${maxLength} characters or null`,
    )
  }
}

function assertBoolean(value: unknown, context: string): asserts value is boolean {
  if (!isBoolean(value)) {
    throw new TypeError(`${context} must be a boolean`)
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  context: string,
): asserts value is number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new TypeError(
      `${context} must be a non-negative safe integer`,
    )
  }
}

function assertOneOf<T extends string>(
  value: unknown,
  context: string,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${context} must be one of: ${allowed.join(', ')}`)
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

function assertLocalMediaIntentMicrophone(
  value: unknown,
): asserts value is LocalMediaIntentMicrophone {
  assertObjectRecord(value, 'LocalMediaIntent.microphone')
  assertNonNegativeSafeInteger(
    value.revision,
    'LocalMediaIntent.microphone.revision',
  )
  assertOneOf(value.state, 'LocalMediaIntent.microphone.state', [
    'off',
    'retain',
    'publish',
  ] as const)

  if (value.state === 'off') {
    return
  }

  if (value.state === 'retain') {
    assertBoolean(value.muted, 'LocalMediaIntent.microphone.muted')
    return
  }

  assertLiveKitNativePublisherCredentials(value.credentials)
  assertBoolean(value.muted, 'LocalMediaIntent.microphone.muted')
  assertIntegerInRange(
    value.audioBitrateKbps,
    'LocalMediaIntent.microphone.audioBitrateKbps',
    6,
    512,
  )
}

function assertLocalMediaIntentScreen(
  value: unknown,
): asserts value is LocalMediaIntentScreen {
  assertObjectRecord(value, 'LocalMediaIntent.screen')
  assertNonNegativeSafeInteger(
    value.revision,
    'LocalMediaIntent.screen.revision',
  )
  assertOneOf(value.state, 'LocalMediaIntent.screen.state', [
    'off',
    'prepare',
    'publish',
  ] as const)

  if (value.state === 'off') {
    return
  }

  assertLiveKitNativePublisherCredentials(value.credentials)
  assertScreenSourceSpec(value.source)
}

export function assertLocalMediaIntent(
  value: unknown,
): asserts value is LocalMediaIntent {
  assertObjectRecord(value, 'LocalMediaIntent')
  if (value.operationId !== null) {
    assertNonEmptyString(value.operationId, 'LocalMediaIntent.operationId', 256)
  }
  assertNonNegativeSafeInteger(
    value.envelopeRevision,
    'LocalMediaIntent.envelopeRevision',
  )
  assertLocalMediaIntentMicrophone(value.microphone)
  assertLocalMediaIntentScreen(value.screen)
  if (
    value.operationId === null &&
    (value.microphone.state !== 'off' || value.screen.state !== 'off')
  ) {
    throw new TypeError(
      'LocalMediaIntent.operationId is required while local media is active',
    )
  }
  if (
    value.microphone.state === 'publish' &&
    !value.microphone.credentials.participantIdentity.endsWith(':microphone')
  ) {
    throw new TypeError(
      'LocalMediaIntent.microphone credentials must identify a microphone publisher',
    )
  }
  if (
    value.screen.state !== 'off' &&
    !value.screen.credentials.participantIdentity.endsWith(':screen')
  ) {
    throw new TypeError(
      'LocalMediaIntent.screen credentials must identify a screen publisher',
    )
  }
}

export function isLocalMediaIntent(value: unknown): value is LocalMediaIntent {
  try {
    assertLocalMediaIntent(value)
    return true
  } catch {
    return false
  }
}

export function parseLocalMediaIntent(value: unknown): LocalMediaIntent {
  assertLocalMediaIntent(value)
  return value
}

export function assertLocalMediaIntentAcceptanceResult(
  value: unknown,
): asserts value is LocalMediaIntentAcceptanceResult {
  assertObjectRecord(value, 'LocalMediaIntentAcceptanceResult')
  if (value.operationId !== null) {
    assertNonEmptyString(
      value.operationId,
      'LocalMediaIntentAcceptanceResult.operationId',
      256,
    )
  }
  assertNonNegativeSafeInteger(
    value.acceptedEnvelopeRevision,
    'LocalMediaIntentAcceptanceResult.acceptedEnvelopeRevision',
  )
  assertOneOf(
    value.disposition,
    'LocalMediaIntentAcceptanceResult.disposition',
    ['accepted', 'duplicate'] as const,
  )
}

export function isLocalMediaIntentAcceptanceResult(
  value: unknown,
): value is LocalMediaIntentAcceptanceResult {
  try {
    assertLocalMediaIntentAcceptanceResult(value)
    return true
  } catch {
    return false
  }
}

export function parseLocalMediaIntentAcceptanceResult(
  value: unknown,
): LocalMediaIntentAcceptanceResult {
  assertLocalMediaIntentAcceptanceResult(value)
  return value
}

export function assertLocalMediaObservedStateEvent(
  value: unknown,
): asserts value is LocalMediaObservedStateEvent {
  assertObjectRecord(value, 'LocalMediaObservedStateEvent')
  assertOneOf(value.kind, 'LocalMediaObservedStateEvent.kind', [
    'microphone',
    'screen',
  ] as const)
  if (value.operationId !== null) {
    assertNonEmptyString(
      value.operationId,
      'LocalMediaObservedStateEvent.operationId',
      256,
    )
  }
  assertNonNegativeSafeInteger(
    value.revision,
    'LocalMediaObservedStateEvent.revision',
  )
  assertNonNegativeSafeInteger(
    value.reconcileAttempt,
    'LocalMediaObservedStateEvent.reconcileAttempt',
  )
  assertNonNegativeSafeInteger(
    value.sequence,
    'LocalMediaObservedStateEvent.sequence',
  )

  if (value.kind === 'microphone') {
    assertOneOf(value.state, 'LocalMediaObservedStateEvent.state', [
      'off',
      'retained',
      'publishing',
      'published',
      'stopping',
      'error',
    ] as const)
    assertBoolean(value.muted, 'LocalMediaObservedStateEvent.muted')
    if (value.audioBitrateKbps !== null) {
      assertIntegerInRange(
        value.audioBitrateKbps,
        'LocalMediaObservedStateEvent.audioBitrateKbps',
        6,
        512,
      )
    }
    assertOptionalNonEmptyString(
      value.participantIdentity,
      'LocalMediaObservedStateEvent.participantIdentity',
      512,
    )

    if (value.state === 'error') {
      assertNonEmptyString(
        value.errorCode,
        'LocalMediaObservedStateEvent.errorCode',
        128,
      )
      assertNonEmptyString(
        value.errorMessage,
        'LocalMediaObservedStateEvent.errorMessage',
        2_048,
      )
      assertNonEmptyString(
        value.errorStage,
        'LocalMediaObservedStateEvent.errorStage',
        128,
      )
      assertBoolean(value.retryable, 'LocalMediaObservedStateEvent.retryable')
    }
    return
  }

  assertOneOf(value.state, 'LocalMediaObservedStateEvent.state', [
    'off',
    'preparing',
    'prepared',
    'publishing',
    'published',
    'stopping',
    'error',
  ] as const)
  if (value.source !== null) {
    assertScreenSourceSpec(value.source)
  }
  assertOptionalNonEmptyString(
    value.participantIdentity,
    'LocalMediaObservedStateEvent.participantIdentity',
    512,
  )

  if (value.state === 'error') {
    assertNonEmptyString(
      value.errorCode,
      'LocalMediaObservedStateEvent.errorCode',
      128,
    )
    assertNonEmptyString(
      value.errorMessage,
      'LocalMediaObservedStateEvent.errorMessage',
      2_048,
    )
    assertNonEmptyString(
      value.errorStage,
      'LocalMediaObservedStateEvent.errorStage',
      128,
    )
    assertBoolean(value.retryable, 'LocalMediaObservedStateEvent.retryable')
  }
}

export function isLocalMediaObservedStateEvent(
  value: unknown,
): value is LocalMediaObservedStateEvent {
  try {
    assertLocalMediaObservedStateEvent(value)
    return true
  } catch {
    return false
  }
}

export function parseLocalMediaObservedStateEvent(
  value: unknown,
): LocalMediaObservedStateEvent {
  assertLocalMediaObservedStateEvent(value)
  return value
}
