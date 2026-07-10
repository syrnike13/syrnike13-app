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
  deviceId?: string
  sampleRate: 48_000
  channels: 1
  noiseSuppression: boolean
  echoCancellation: boolean
  inputVolume: number
  audioBitrate?: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
  muted?: boolean
  livekit: NativeMediaLiveKitCredentials
}

export type NativeMicrophoneRuntimeConfig = {
  inputVolume?: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
  noiseSuppression?: boolean
  echoCancellation?: boolean
}

export type NativeMicrophonePreviewStartOptions = {
  deviceId?: string
  sampleRate: 48_000
  channels: 1
  noiseSuppression: boolean
  echoCancellation: boolean
  inputVolume: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
}

export type NativeMicrophonePreviewSession = {
  sessionId: string
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
  sessionId: string
  inputDb: number
  thresholdDb: number
  open: boolean
}

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
