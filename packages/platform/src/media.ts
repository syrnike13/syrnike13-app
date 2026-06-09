/** Метод hybrid media engine (счётчики как в Discord RTC debug). */
export type NativeMediaFrameMethod =
  | 'wgc'
  | 'dxgi'
  | 'gdi_blt'
  | 'gdi_print'

export type NativeMediaFrameStats = Record<NativeMediaFrameMethod, number>

export type NativeMediaEncoderBackend =
  | 'media_foundation'
  | 'webrtc'
  | 'openh264'

/** process/system_exclude = звук демонстрации; microphone = входной голос; none = звук недоступен. */
export type NativeMediaAudioMode =
  | 'process'
  | 'system_exclude'
  | 'microphone'
  | 'none'

export type NativeMediaLoopbackMode =
  | 'include_target_process_tree'
  | 'exclude_target_process_tree'

export type NativeMediaEchoCancellationMode =
  | 'disabled'
  | 'windows'
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

export type NativeMediaScreenSessionStartOptions = {
  kind: 'screen'
  sourceId: string
  width: number
  height: number
  fps: number
  bitrate: number
  audio?: {
    requested: boolean
  }
  livekit: {
    url: string
    token: string
    participantIdentity: string
  }
}

export type NativeMediaMicrophoneSessionStartOptions = {
  kind: 'microphone'
  deviceId?: string
  sampleRate: 48_000
  channels: 1
  echoCancellation: boolean
  inputVolume: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
  muted?: boolean
  livekit: {
    url: string
    token: string
    participantIdentity: string
  }
}

export type NativeMicrophoneRuntimeConfig = {
  inputVolume?: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
  echoCancellation?: boolean
}

export type NativeMicrophonePreviewStartOptions = {
  deviceId?: string
  sampleRate: 48_000
  channels: 1
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
  port?: number
  encoder: NativeMediaEncoderBackend
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  audio?: {
    mode: NativeMediaAudioMode
    port?: number
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
      port?: number
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

export type NativeMediaEngineSessionSummary = {
  kind: NativeMediaSessionKind
  sessionId: string
  status: 'starting' | 'running' | 'error'
  port?: number
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  audio?: {
    mode: NativeMediaAudioMode
    port?: number
    sampleRate?: 48_000
    channels?: 1 | 2
    echoCancellation?: NativeMediaEchoCancellationMode
    targetProcessId?: number
    loopbackMode?: NativeMediaLoopbackMode
  }
}

export type NativeMediaEngineSnapshot = {
  available: boolean
  helper: {
    available: boolean
    running: boolean
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
  videoAvgCaptureUs?: number
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
    port?: number
    sampleRate?: 48_000
    channels?: 1 | 2
    echoCancellation?: NativeMediaEchoCancellationMode
    targetProcessId?: number
    loopbackMode?: NativeMediaLoopbackMode
  }
}

export type NativeMediaSidecarLostEvent = {
  sessionId: string
  reason: 'exit' | 'stream_error'
  message: string
}
