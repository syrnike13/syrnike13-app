/** Метод hybrid media engine (счётчики как в Discord RTC debug). */
export type NativeMediaFrameMethod =
  | 'wgc'
  | 'dxgi'
  | 'gdi_blt'
  | 'gdi_print'

export type NativeMediaFrameStats = Record<NativeMediaFrameMethod, number>

export type NativeMediaStreamMode = 'h264' | 'bgra'

export type NativeMediaEncoderBackend =
  | 'media_foundation'
  | 'openh264'

/** process/system_exclude = звук демонстрации; microphone = входной голос; none = звук недоступен. */
export type NativeMediaAudioMode =
  | 'process'
  | 'system_exclude'
  | 'microphone'
  | 'none'

export type NativeMediaNoiseSuppressionMode =
  | 'disabled'
  | 'deep_filter_net3'

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
  streamMode?: NativeMediaStreamMode
  audio?: {
    requested: boolean
  }
}

export type NativeMediaMicrophoneSessionStartOptions = {
  kind: 'microphone'
  deviceId?: string
  sampleRate: 48_000
  channels: 1
  echoCancellation: boolean
  noiseSuppression: NativeMediaNoiseSuppressionMode
  inputVolume: number
}

export type NativeMediaSessionStartOptions =
  | NativeMediaScreenSessionStartOptions
  | NativeMediaMicrophoneSessionStartOptions

export type NativeMediaScreenSession = {
  kind: 'screen'
  sessionId: string
  port: number
  streamMode: NativeMediaStreamMode
  encoder: NativeMediaEncoderBackend
  audio?: {
    mode: NativeMediaAudioMode
    port?: number
  }
}

export type NativeMediaMicrophoneSession = {
  kind: 'microphone'
  sessionId: string
  audio: {
    mode: 'microphone'
    port: number
    sampleRate: 48_000
    channels: 1
    noiseSuppression: NativeMediaNoiseSuppressionMode
  }
}

export type NativeMediaSession =
  | NativeMediaScreenSession
  | NativeMediaMicrophoneSession

export type NativeMediaSessionStatus =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running'; sessionId: string; port?: number }
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
  audio?: {
    mode: NativeMediaAudioMode
    port?: number
    sampleRate?: 48_000
    channels?: 1 | 2
    noiseSuppression?: NativeMediaNoiseSuppressionMode
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
}

export type NativeMediaStateEvent = NativeMediaSessionStatus & {
  sessionId?: string
  audio?: {
    mode: NativeMediaAudioMode
    port?: number
    sampleRate?: 48_000
    channels?: 1 | 2
    noiseSuppression?: NativeMediaNoiseSuppressionMode
  }
}

export type NativeMediaSidecarLostEvent = {
  sessionId: string
  reason: 'exit' | 'stream_error'
  message: string
}
