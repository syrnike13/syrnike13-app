import {
  LiveKitNativePublisherCredentialsSchema,
  NativeInputEventSchema,
  VoiceRtcStreamTelemetrySchema,
  VoiceRtcTransportTelemetrySchema,
  VoiceRemoteAudioSettingsSchema,
} from '@syrnike13/platform'
import type { NativeMediaSession } from '@syrnike13/platform'
import { Option, Schema } from 'effect'

export const NATIVE_RUNTIME_CONTRACT_VERSION = 8
export const NATIVE_RUNTIME_MAX_PENDING_REQUESTS = 256

const nonEmptyString = (maximumLength = 4_096) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumLength),
  )

const nonNegativeInteger = Schema.Natural

export const NativeRuntimeErrorSchema = Schema.Struct({
  code: nonEmptyString(128),
  message: nonEmptyString(),
  stage: Schema.optional(nonEmptyString(128)),
  retryable: Schema.Boolean,
  sessionId: Schema.optional(nonEmptyString(256)),
  generation: Schema.optional(nonNegativeInteger),
  hresult: Schema.optional(Schema.Int),
})

const NativeRuntimeBuildSchema = Schema.Record(
  Schema.String,
  Schema.String,
)

const NativeRuntimeReadySchema = Schema.Struct({
  type: Schema.Literal('ready'),
  contractVersion: Schema.Int,
  runtime: Schema.Literals(['media', 'hotkey', 'overlay', 'invalid']),
  capabilities: Schema.UniqueArray(nonEmptyString(128)).check(
    Schema.isMaxLength(32),
  ),
  build: NativeRuntimeBuildSchema,
})

const NativeRuntimeReplySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('reply'),
    requestId: nonEmptyString(256),
    ok: Schema.Literal(true),
    result: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal('reply'),
    requestId: nonEmptyString(256),
    ok: Schema.Literal(false),
    error: NativeRuntimeErrorSchema,
  }),
])

const UncorrelatedNativeRuntimeReplySchema = Schema.Struct({
  type: Schema.Literal('reply'),
  requestId: Schema.optional(Schema.Never),
  ok: Schema.Boolean,
})

export const SCREEN_BACKEND_RESTART_REASONS = [
  'reinitialize_active',
  'recreate_active_pipeline',
  'recreate_device',
  'switch_backend',
  'probe_preferred_backend',
] as const

export type ScreenBackendRestartReason =
  (typeof SCREEN_BACKEND_RESTART_REASONS)[number]

export type NativeRuntimeKind = 'media' | 'hotkey' | 'overlay'

export type NativeRuntimeBuild = typeof NativeRuntimeBuildSchema.Type

export type NativeRuntimeReady = typeof NativeRuntimeReadySchema.Type

export type NativeRuntimeReply = typeof NativeRuntimeReplySchema.Type

export type NativeRuntimeMessage = typeof NativeRuntimeMessageSchema.Type
export type NativeRuntimeEventMessage = Extract<
  NativeRuntimeMessage,
  { readonly type: 'event' }
>

export type NativeRuntimeError = typeof NativeRuntimeErrorSchema.Type

const integerInRange = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const finiteNumberInRange = (minimum: number, maximum: number) =>
  Schema.Finite.check(Schema.isBetween({ minimum, maximum }))

const Uint32Schema = integerInRange(0, 0xffff_ffff)
const PositiveUint32Schema = integerInRange(1, 0xffff_ffff)

const UnsignedIntegerStringSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!/^(?:0|[1-9]\d{0,19})$/.test(value)) return false
    try {
      return BigInt(value) <= 0xffff_ffff_ffff_ffffn
    } catch {
      return false
    }
  }, { expected: 'an unsigned 64-bit integer string' }),
)

const MicrophonePipelineConfigSchema = Schema.Struct({
  deviceId: Schema.Union([Schema.Null, nonEmptyString(2_048)]),
  bypassSystemAudioInputProcessing: Schema.Boolean,
  automaticGainControl: Schema.Boolean,
  noiseSuppression: Schema.Boolean,
  echoCancellation: Schema.Boolean,
  inputVolume: finiteNumberInRange(0, 4),
  voiceGateEnabled: Schema.Boolean,
  voiceGateThresholdDb: finiteNumberInRange(-100, 0),
  voiceGateAutoThreshold: Schema.Boolean,
})

const MicrophoneStartOptionsSchema = Schema.Struct({
  kind: Schema.Literal('microphone'),
  requestId: nonEmptyString(256),
  audioBitrate: Schema.optional(integerInRange(6_000, 512_000)),
  muted: Schema.optional(Schema.Boolean),
  participantIdentity: nonEmptyString(512),
  livekit: Schema.optional(Schema.Never),
})

const ScreenStartOptionsSchema = Schema.Struct({
  kind: Schema.Literal('screen'),
  requestId: nonEmptyString(256),
  sourceId: nonEmptyString(2_048),
  width: integerInRange(64, 7_680),
  height: integerInRange(64, 4_320),
  fps: integerInRange(1, 240),
  bitrate: integerInRange(32_000, 100_000_000),
  audioBitrate: Schema.optional(integerInRange(6_000, 512_000)),
  audio: Schema.optional(Schema.Struct({
    requested: Schema.Boolean,
  })),
  participantIdentity: nonEmptyString(512),
  livekit: Schema.optional(Schema.Never),
})

const CameraStartOptionsSchema = Schema.Struct({
  deviceId: Schema.optional(nonEmptyString(2_048)),
  width: Schema.optional(integerInRange(16, 7_680)),
  height: Schema.optional(integerInRange(16, 4_320)),
  fps: Schema.optional(integerInRange(1, 240)),
  bitrate: Schema.optional(integerInRange(32_000, 100_000_000)),
  participantIdentity: nonEmptyString(512),
  livekit: Schema.optional(Schema.Never),
})

const sessionCommandFields = {
  sessionId: nonEmptyString(256),
  generation: nonNegativeInteger,
}

const MediaRuntimeCommandSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('connectVoice'),
    ...sessionCommandFields,
    options: Schema.Struct({
      livekit: LiveKitNativePublisherCredentialsSchema,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('disconnectVoice'),
    ...sessionCommandFields,
  }),
  Schema.Struct({
    type: Schema.Literal('configureRemoteAudio'),
    ...sessionCommandFields,
    settings: VoiceRemoteAudioSettingsSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('releaseRemoteVideoFrame'),
    ...sessionCommandFields,
    trackId: nonEmptyString(512),
    sequence: nonNegativeInteger,
  }),
  Schema.Struct({
    type: Schema.Literal('setRemoteVideoDemand'),
    ...sessionCommandFields,
    trackId: nonEmptyString(512),
    demanded: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('retryRemoteVideo'),
    ...sessionCommandFields,
    trackId: nonEmptyString(512),
    reason: nonEmptyString(256),
  }),
  Schema.Struct({
    type: Schema.Literal('setLocalScreenPreviewDemand'),
    ...sessionCommandFields,
    demanded: Schema.Boolean,
    electronMainPid: PositiveUint32Schema,
    options: Schema.Struct({
      width: integerInRange(16, 3_840),
      height: integerInRange(16, 2_160),
      fps: integerInRange(1, 60),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('releaseLocalScreenPreviewFrame'),
    ...sessionCommandFields,
    trackId: nonEmptyString(512),
    sequence: nonNegativeInteger,
  }),
  Schema.Struct({
    type: Schema.Literal('releaseLocalCameraPreviewFrame'),
    ...sessionCommandFields,
    trackId: nonEmptyString(512),
    sequence: nonNegativeInteger,
  }),
  Schema.Struct({
    type: Schema.Literal('configureVoiceOutput'),
    ...sessionCommandFields,
    deafened: Schema.Boolean,
    deviceId: Schema.optional(nonEmptyString(2_048)),
    volume: Schema.optional(finiteNumberInRange(0, 3)),
  }),
  Schema.Struct({
    type: Schema.Literal('warmMicrophone'),
    generation: nonNegativeInteger,
    config: MicrophonePipelineConfigSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('listDevices'),
    kind: Schema.Literals(['audioinput', 'audiooutput', 'videoinput']),
  }),
  Schema.Struct({
    type: Schema.Literal('listDisplaySources'),
    selfWindowHwnd: Schema.optional(UnsignedIntegerStringSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('startPreview'),
    ...sessionCommandFields,
  }),
  Schema.Struct({
    type: Schema.Literal('stopPreview'),
    sessionId: Schema.optional(nonEmptyString(256)),
    generation: Schema.optional(nonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal('connectScreen'),
    ...sessionCommandFields,
    options: Schema.Struct({
      participantIdentity: nonEmptyString(512),
      livekit: Schema.optional(Schema.Never),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('disconnectScreen'),
    generation: nonNegativeInteger,
    sessionId: Schema.optional(nonEmptyString(256)),
    terminal: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('connectMicrophone'),
    ...sessionCommandFields,
    options: MicrophoneStartOptionsSchema,
    excludeProcessId: Uint32Schema,
  }),
  Schema.Struct({
    type: Schema.Literal('startScreenCapture'),
    ...sessionCommandFields,
    options: ScreenStartOptionsSchema,
    selfWindowHwnd: Schema.optional(UnsignedIntegerStringSchema),
    excludeProcessId: Uint32Schema,
  }),
  Schema.Struct({
    type: Schema.Literal('disconnectMicrophone'),
    ...sessionCommandFields,
  }),
  Schema.Struct({
    type: Schema.Literal('connectCamera'),
    ...sessionCommandFields,
    options: CameraStartOptionsSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('disconnectCamera'),
    ...sessionCommandFields,
  }),
  Schema.Struct({
    type: Schema.Literal('invalidateMicrophone'),
    ...sessionCommandFields,
  }),
  Schema.Struct({
    type: Schema.Literal('stopScreenCapture'),
    ...sessionCommandFields,
  }),
  Schema.Struct({
    type: Schema.Literal('configureMicrophone'),
    revision: nonNegativeInteger,
    config: MicrophonePipelineConfigSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('setMicrophoneMuted'),
    ...sessionCommandFields,
    muted: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal('probeMicrophoneActor') }),
  Schema.Struct({ type: Schema.Literal('probeScreenActor') }),
  Schema.Struct({ type: Schema.Literal('probeCameraActor') }),
  Schema.Struct({ type: Schema.Literal('probeQueryWorker') }),
  Schema.Struct({ type: Schema.Literal('shutdown') }),
])

const HooksRuntimeCommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('startHotkeys') }),
  Schema.Struct({ type: Schema.Literal('stopHotkeys') }),
  Schema.Struct({ type: Schema.Literal('startOverlay') }),
  Schema.Struct({ type: Schema.Literal('stopOverlay') }),
  Schema.Struct({ type: Schema.Literal('probeHooksRuntime') }),
  Schema.Struct({ type: Schema.Literal('shutdown') }),
])

export const NativeRuntimeCommandSchema = Schema.Union([
  MediaRuntimeCommandSchema,
  HooksRuntimeCommandSchema,
])

const NativeRuntimeDiagnosticContextSchema = Schema.Struct({
  actionId: nonEmptyString(128),
  operationId: Schema.optional(nonEmptyString(128)),
  revision: Schema.optional(nonNegativeInteger),
  hostEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
})

export const NativeRuntimeRequestSchema = Schema.Struct({
  type: Schema.Literal('request'),
  requestId: nonEmptyString(256),
  command: NativeRuntimeCommandSchema,
  diagnostic: Schema.optional(NativeRuntimeDiagnosticContextSchema),
})

export type MediaRuntimeCommand = typeof MediaRuntimeCommandSchema.Type
export type HooksRuntimeCommand = typeof HooksRuntimeCommandSchema.Type
export type NativeRuntimeCommand = typeof NativeRuntimeCommandSchema.Type
export type NativeRuntimeDiagnosticContext =
  typeof NativeRuntimeDiagnosticContextSchema.Type
export type NativeRuntimeRequest = typeof NativeRuntimeRequestSchema.Type

const screenAudioModeSchema = Schema.Literals([
  'process',
  'system_exclude',
  'none',
])

const mediaAudioSchema = Schema.Struct({
  mode: Schema.Literals(['microphone', 'process', 'system_exclude', 'none']),
})

const nativeMediaStateFields = {
  sessionId: Schema.optional(nonEmptyString(256)),
  deviceId: Schema.optional(nonEmptyString(512)),
  message: Schema.optional(nonEmptyString()),
  width: Schema.optional(integerInRange(16, 7_680)),
  height: Schema.optional(integerInRange(16, 4_320)),
  fps: Schema.optional(integerInRange(1, 240)),
  bitrate: Schema.optional(integerInRange(32_000, 100_000_000)),
  audio: Schema.optional(mediaAudioSchema),
}

const NativeMediaStateEventSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('idle'),
    ...nativeMediaStateFields,
  }),
  Schema.Struct({
    status: Schema.Literal('starting'),
    ...nativeMediaStateFields,
  }),
  Schema.Struct({
    status: Schema.Literal('running'),
    ...nativeMediaStateFields,
    sessionId: nonEmptyString(256),
  }),
  Schema.Struct({
    status: Schema.Literal('error'),
    ...nativeMediaStateFields,
    message: nonEmptyString(),
  }),
])

const NativeMediaSessionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('microphone'),
    sessionId: nonEmptyString(256),
    audio: Schema.Struct({
      mode: Schema.Literal('microphone'),
      sampleRate: Schema.Literal(48_000),
      channels: Schema.Literal(1),
      noiseSuppression: Schema.Literals([
        'disabled',
        'software',
        'unavailable',
      ]),
      echoCancellation: Schema.Literals([
        'disabled',
        'software',
        'unavailable',
      ]),
    }),
    nativeParticipantIdentity: nonEmptyString(512),
  }),
  Schema.Struct({
    kind: Schema.Literal('screen'),
    sessionId: nonEmptyString(256),
    encoder: Schema.Literal('mf_h264_d3d11'),
    width: Schema.optional(integerInRange(16, 7_680)),
    height: Schema.optional(integerInRange(16, 4_320)),
    fps: Schema.optional(integerInRange(1, 240)),
    bitrate: Schema.optional(integerInRange(32_000, 100_000_000)),
    audio: Schema.optional(Schema.Struct({
      mode: screenAudioModeSchema,
      targetProcessId: Schema.optional(Uint32Schema),
      loopbackMode: Schema.optional(Schema.Literals([
        'include_target_process_tree',
        'exclude_target_process_tree',
      ])),
    })),
    nativeParticipantIdentity: Schema.optional(nonEmptyString(512)),
  }),
])

const NativeMediaStatsSchema = Schema.Struct({
  sessionId: nonEmptyString(256),
  methods: Schema.Struct({
    wgc_gpu: finiteNumberInRange(0, Number.MAX_SAFE_INTEGER),
    dxgi_gpu: finiteNumberInRange(0, Number.MAX_SAFE_INTEGER),
  }),
  activeMethod: Schema.optional(Schema.Literals(['wgc_gpu', 'dxgi_gpu'])),
  audioFrames: Schema.optional(Schema.Finite),
  audioPackets: Schema.optional(Schema.Finite),
  audioPeakDb: Schema.optional(Schema.Finite),
  audioRmsDb: Schema.optional(Schema.Finite),
  videoFrames: Schema.optional(Schema.Finite),
  videoIntervalFrames: Schema.optional(Schema.Finite),
  videoLateFrames: Schema.optional(Schema.Finite),
  videoNoFrameCount: Schema.optional(Schema.Finite),
  videoRepeatedFrameCount: Schema.optional(Schema.Finite),
  videoRecoverableLostCount: Schema.optional(Schema.Finite),
  videoGpuPoolSlotsAvailable: Schema.optional(Schema.Finite),
  videoGpuPoolSlotsTotal: Schema.optional(Schema.Finite),
  videoDxgiDuplicationHoldUsMax: Schema.optional(Schema.Finite),
  videoSourceUpdates: Schema.optional(Schema.Finite),
  videoGpuSubmissions: Schema.optional(Schema.Finite),
  videoIdleRefreshes: Schema.optional(Schema.Finite),
  videoCoalescedSourceUpdates: Schema.optional(Schema.Finite),
  videoEncoderBackpressureTicks: Schema.optional(Schema.Finite),
  videoSupersededReadyFrames: Schema.optional(Schema.Finite),
  videoGpuSlotTimeouts: Schema.optional(Schema.Finite),
  videoGpuSlotsRecovered: Schema.optional(Schema.Finite),
  videoGpuFramesDroppedStale: Schema.optional(Schema.Finite),
  videoGpuPoolRollovers: Schema.optional(Schema.Finite),
  videoGpuRolloversBlocked: Schema.optional(Schema.Finite),
  videoGpuRetiredGenerations: Schema.optional(Schema.Finite),
  videoGpuSlotsQuarantined: Schema.optional(Schema.Finite),
  videoPreviewBridgeSubmissions: Schema.optional(Schema.Finite),
  videoPreviewBridgeAcquires: Schema.optional(Schema.Finite),
  videoPreviewBridgeTimeouts: Schema.optional(Schema.Finite),
  videoPreviewBridgeSlotsRecovered: Schema.optional(Schema.Finite),
  videoPreviewGpuSubmissions: Schema.optional(Schema.Finite),
  videoPreviewFramesCompleted: Schema.optional(Schema.Finite),
  videoPreviewSlotTimeouts: Schema.optional(Schema.Finite),
  videoPreviewFramesDroppedStale: Schema.optional(Schema.Finite),
  videoPreviewDeviceResets: Schema.optional(Schema.Finite),
  videoGpuCompletionP50Us: Schema.optional(Schema.Finite),
  videoGpuCompletionP95Us: Schema.optional(Schema.Finite),
  videoGpuCompletionMaxUs: Schema.optional(Schema.Finite),
  videoAvgCaptureUs: Schema.optional(Schema.Finite),
  videoAvgReadbackUs: Schema.optional(Schema.Finite),
  videoAvgScaleUs: Schema.optional(Schema.Finite),
  videoAvgPublishUs: Schema.optional(Schema.Finite),
  videoSourceWidth: Schema.optional(Schema.Finite),
  videoSourceHeight: Schema.optional(Schema.Finite),
  videoContentWidth: Schema.optional(Schema.Finite),
  videoContentHeight: Schema.optional(Schema.Finite),
  publishedVideo: Schema.optional(Schema.Boolean),
  publishedAudio: Schema.optional(Schema.Boolean),
  captureThreadMmcss: Schema.optional(Schema.Boolean),
})

const runtimeEventFields = {
  sequence: nonNegativeInteger,
}

const sessionEventFields = {
  ...runtimeEventFields,
  sessionId: nonEmptyString(256),
  generation: nonNegativeInteger,
  requestId: Schema.optional(nonEmptyString(256)),
}

const RuntimeErrorEventSchema = Schema.Struct({
  type: Schema.Literal('runtimeError'),
  ...runtimeEventFields,
  sessionId: Schema.optional(nonEmptyString(256)),
  generation: Schema.optional(nonNegativeInteger),
  error: NativeRuntimeErrorSchema,
}).check(
  Schema.makeFilter(
    (event) =>
      (event.sessionId === undefined ||
        event.sessionId === event.error.sessionId) &&
      (event.generation === undefined ||
        event.generation === event.error.generation),
    { expected: 'runtime error fences matching the event' },
  ),
)

const InputEventSchema = Schema.Struct({
  type: Schema.Literal('input'),
  ...runtimeEventFields,
  input: NativeInputEventSchema,
})

const ForegroundWindowEventSchema = Schema.Struct({
  type: Schema.Literal('foregroundWindow'),
  ...runtimeEventFields,
  window: Schema.Struct({
    pid: Schema.Int,
    processName: Schema.String.check(Schema.isMaxLength(4_096)),
    processPath: Schema.Union([
      Schema.Null,
      Schema.String.check(Schema.isMaxLength(32_768)),
    ]),
    title: Schema.String.check(Schema.isMaxLength(32_768)),
    className: Schema.String.check(Schema.isMaxLength(4_096)),
    visible: Schema.Boolean,
    fullscreenLike: Schema.Boolean,
    bounds: Schema.Struct({
      x: Schema.Finite,
      y: Schema.Finite,
      width: Schema.Finite,
      height: Schema.Finite,
    }),
  }),
})

const SessionLifecycleEventSchema = Schema.Struct({
  type: Schema.Literal('sessionLifecycle'),
  ...sessionEventFields,
  kind: Schema.optional(Schema.Literals([
    'voice',
    'microphone',
    'screen',
    'camera',
    'output',
  ])),
  state: NativeMediaStateEventSchema,
  error: Schema.optional(NativeRuntimeErrorSchema),
}).check(
  Schema.makeFilter(
    (event) =>
      (event.state.sessionId === undefined ||
        event.state.sessionId === event.sessionId) &&
      (event.error === undefined ||
        ((event.error.sessionId === undefined ||
          event.error.sessionId === event.sessionId) &&
          (event.error.generation === undefined ||
            event.error.generation === event.generation))),
    { expected: 'media state and error fences matching the session event' },
  ),
)

const VoiceConnectionStateEventSchema = Schema.Struct({
  type: Schema.Literal('voiceConnectionState'),
  ...sessionEventFields,
  state: Schema.Literals(['connected', 'reconnecting']),
})

const SessionStartedEventSchema = Schema.Struct({
  type: Schema.Literal('sessionStarted'),
  ...sessionEventFields,
  session: NativeMediaSessionSchema,
}).check(
  Schema.makeFilter(
    (event) => event.session.sessionId === event.sessionId,
    { expected: 'a media session matching the event session' },
  ),
)

const StatsEventSchema = Schema.Struct({
  type: Schema.Literal('stats'),
  ...sessionEventFields,
  stats: NativeMediaStatsSchema,
}).check(
  Schema.makeFilter(
    (event) => event.stats.sessionId === event.sessionId,
    { expected: 'media stats matching the event session' },
  ),
)

const VoiceStatsEventSchema = Schema.Struct({
  type: Schema.Literal('voiceStats'),
  ...sessionEventFields,
  stats: Schema.Struct({
    transport: VoiceRtcTransportTelemetrySchema,
    outbound: Schema.Array(VoiceRtcStreamTelemetrySchema),
    inbound: Schema.Array(VoiceRtcStreamTelemetrySchema),
  }),
})

const TerminalEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('voiceTerminal'),
    ...sessionEventFields,
    error: NativeRuntimeErrorSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('cameraTerminal'),
    ...sessionEventFields,
    error: NativeRuntimeErrorSchema,
  }),
]).check(
  Schema.makeFilter(
    (event) =>
      event.error.sessionId === event.sessionId &&
      event.error.generation === event.generation,
    { expected: 'terminal error fences matching the session event' },
  ),
)

const videoFrameFields = {
  ...sessionEventFields,
  trackId: nonEmptyString(512),
  participantIdentity: Schema.String.check(Schema.isMaxLength(512)),
  frameSequence: nonNegativeInteger,
  timestampUs: nonNegativeInteger,
  width: integerInRange(1, 7_680),
  height: integerInRange(1, 4_320),
  ntHandle: Schema.Uint8Array.check(
    Schema.makeFilter(
      (handle) => handle.byteLength === 8,
      { expected: 'an 8-byte NT handle' },
    ),
  ),
}

const LocalScreenPreviewFailureSchema = Schema.Struct({
  type: Schema.Literal('localScreenPreviewFailed'),
  ...sessionEventFields,
  trackId: nonEmptyString(512),
  error: NativeRuntimeErrorSchema,
}).check(
  Schema.makeFilter(
    (event) =>
      event.error.code === 'LOCAL_SCREEN_PREVIEW_FAILED' &&
      event.error.sessionId === event.sessionId &&
      event.error.generation === event.generation,
    { expected: 'a local screen preview error matching the session event' },
  ),
)

const LocalCameraPreviewFailureSchema = Schema.Struct({
  type: Schema.Literal('localCameraPreviewFailed'),
  ...sessionEventFields,
  trackId: nonEmptyString(512),
  error: NativeRuntimeErrorSchema,
}).check(
  Schema.makeFilter(
    (event) =>
      event.error.code === 'LOCAL_CAMERA_PREVIEW_FAILED' &&
      event.error.sessionId === event.sessionId &&
      event.error.generation === event.generation,
    { expected: 'a local camera preview error matching the session event' },
  ),
)

export const NativeRuntimeEventSchema = Schema.Union([
  InputEventSchema,
  ForegroundWindowEventSchema,
  RuntimeErrorEventSchema,
  SessionLifecycleEventSchema,
  VoiceConnectionStateEventSchema,
  SessionStartedEventSchema,
  Schema.Struct({
    type: Schema.Literal('sessionStopped'),
    ...sessionEventFields,
    reason: Schema.optional(Schema.String),
  }),
  StatsEventSchema,
  VoiceStatsEventSchema,
  Schema.Struct({
    type: Schema.Literal('screenBackendRestart'),
    ...sessionEventFields,
    backend: Schema.Literals(['dxgi_gpu', 'wgc_gpu']),
    reason: Schema.Literals(SCREEN_BACKEND_RESTART_REASONS),
    count: Schema.Int.check(Schema.isGreaterThan(0)),
    errorCode: Schema.optional(Schema.String),
    hresult: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    type: Schema.Literal('microphoneMetrics'),
    ...runtimeEventFields,
    metrics: Schema.Struct({
      revision: nonNegativeInteger,
      inputDb: Schema.Finite,
      thresholdDb: Schema.Finite,
      open: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('microphonePreviewStarted'),
    ...sessionEventFields,
    preview: Schema.Struct({
      sessionId: nonEmptyString(256),
    }),
  }).check(
    Schema.makeFilter(
      (event) => event.preview.sessionId === event.sessionId,
      { expected: 'a microphone preview matching the event session' },
    ),
  ),
  Schema.Struct({
    type: Schema.Literal('deviceList'),
    ...runtimeEventFields,
    devices: Schema.Array(Schema.Struct({
      deviceId: nonEmptyString(2_048),
      kind: Schema.Literals(['audioinput', 'audiooutput', 'videoinput']),
      label: Schema.String.check(Schema.isMaxLength(4_096)),
    })),
  }),
  Schema.Struct({
    type: Schema.Literal('displaySourceList'),
    ...runtimeEventFields,
    sources: Schema.Array(Schema.Struct({
      id: nonEmptyString(2_048),
      name: Schema.String.check(Schema.isMaxLength(32_768)),
      type: Schema.Literals(['screen', 'window', 'game']),
    })),
  }),
  Schema.Struct({
    type: Schema.Literal('screenCaptureEnded'),
    ...sessionEventFields,
    reason: nonEmptyString(256),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(4_096)),
    ),
  }),
  TerminalEventSchema,
  Schema.Struct({
    type: Schema.Literal('activeSpeakers'),
    ...sessionEventFields,
    participantIdentities: Schema.Array(nonEmptyString(512)).check(
      Schema.isMaxLength(512),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('remoteVideoFrame'),
    ...videoFrameFields,
    source: Schema.Literals(['camera', 'screen']),
  }),
  Schema.Struct({
    type: Schema.Literal('localScreenPreviewFrame'),
    ...videoFrameFields,
    source: Schema.Literal('screen'),
  }),
  Schema.Struct({
    type: Schema.Literal('localCameraPreviewFrame'),
    ...videoFrameFields,
    source: Schema.Literal('camera'),
  }),
  Schema.Struct({
    type: Schema.Literal('remoteVideoTrackRemoved'),
    ...sessionEventFields,
    trackId: nonEmptyString(512),
  }),
  Schema.Struct({
    type: Schema.Literal('remoteVideoPublicationAvailable'),
    ...sessionEventFields,
    trackId: nonEmptyString(512),
    participantIdentity: nonEmptyString(512),
    source: Schema.Literals(['camera', 'screen']),
  }),
  Schema.Struct({
    type: Schema.Literal('remoteVideoPublicationUnavailable'),
    ...sessionEventFields,
    trackId: nonEmptyString(512),
    participantIdentity: nonEmptyString(512),
    source: Schema.Literals(['camera', 'screen']),
  }),
  Schema.Struct({
    type: Schema.Literal('localScreenPreviewTrackRemoved'),
    ...sessionEventFields,
    trackId: nonEmptyString(512),
    source: Schema.Literal('screen'),
  }),
  Schema.Struct({
    type: Schema.Literal('localCameraPreviewTrackRemoved'),
    ...sessionEventFields,
    trackId: nonEmptyString(512),
    source: Schema.Literal('camera'),
  }),
  LocalScreenPreviewFailureSchema,
  LocalCameraPreviewFailureSchema,
  Schema.Struct({
    type: Schema.Literal('remoteVideoFailed'),
    ...sessionEventFields,
    trackId: nonEmptyString(512),
    source: Schema.optional(Schema.Literals(['camera', 'screen'])),
    reason: Schema.optional(Schema.Literals(['local', 'subscription'])),
  }),
])

export type NativeRuntimeEvent = typeof NativeRuntimeEventSchema.Type
export type MediaRuntimeEvent = Exclude<
  NativeRuntimeEvent,
  { readonly type: 'input' | 'foregroundWindow' }
>
export type HooksRuntimeEvent = Extract<
  NativeRuntimeEvent,
  { readonly type: 'input' | 'foregroundWindow' | 'runtimeError' }
>
export type OverlayForegroundWindow = Extract<
  NativeRuntimeEvent,
  { readonly type: 'foregroundWindow' }
>['window']

export const NativeRuntimeMessageSchema = Schema.Union([
  NativeRuntimeReadySchema,
  NativeRuntimeReplySchema,
  Schema.Struct({
    type: Schema.Literal('event'),
    event: NativeRuntimeEventSchema,
  }),
])

export function isNativeMediaSession(value: unknown): value is NativeMediaSession {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeMediaSessionSchema)(value),
  )
}

export function isNativeRuntimeCommand(value: unknown): value is NativeRuntimeCommand {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeCommandSchema)(value),
  )
}

export function isNativeRuntimeRequest(value: unknown): value is NativeRuntimeRequest {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeRequestSchema)(value),
  )
}

export function isNativeRuntimeReady(value: unknown): value is NativeRuntimeReady {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeReadySchema)(value),
  )
}

export function isNativeRuntimeReply(value: unknown): value is NativeRuntimeReply {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeReplySchema)(value),
  )
}

export function isUncorrelatedNativeRuntimeReply(
  value: unknown,
): value is Record<string, unknown> & {
  type: 'reply'
  requestId?: undefined
  ok: boolean
} {
  return Option.isSome(
    Schema.decodeUnknownOption(UncorrelatedNativeRuntimeReplySchema)(value),
  )
}

export function isNativeRuntimeEvent(
  value: unknown,
): value is NativeRuntimeEvent {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeEventSchema)(value),
  )
}

export function isNativeRuntimeMessage(
  value: unknown,
): value is NativeRuntimeMessage {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeMessageSchema)(value),
  )
}

export function nativeRuntimeError(
  code: string,
  message: string,
  options: Partial<Omit<NativeRuntimeError, 'code' | 'message'>> = {},
): NativeRuntimeError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    stage: options.stage,
    sessionId: options.sessionId,
    generation: options.generation,
    hresult: options.hresult,
  }
}

export function sanitizeRuntimeError(error: unknown): NativeRuntimeError {
  const decoded = Schema.decodeUnknownOption(NativeRuntimeErrorSchema)(error)
  if (Option.isSome(decoded)) {
    return {
      ...decoded.value,
      message: redactSensitiveText(decoded.value.message),
      stage: decoded.value.stage
        ? redactSensitiveText(decoded.value.stage).slice(0, 128)
        : undefined,
    }
  }
  const message = error instanceof Error ? error.message : 'Native runtime failed'
  return nativeRuntimeError('native_failure', redactSensitiveText(message))
}

export function redactSensitiveText(
  value: string,
  maximumLength = 4_096,
) {
  return value
    .replace(
      /\b(token|access_token|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:wss?|https?):\/\/[^\s,;]+/gi, '[redacted-url]')
    .replace(
      /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      '[redacted]',
    )
    .slice(0, maximumLength)
}
