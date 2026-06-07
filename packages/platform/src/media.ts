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

/** process = звук окна; system_exclude = системный вывод без Syrnike; none = звук недоступен. */
export type NativeMediaAudioMode = 'process' | 'system_exclude' | 'none'

export type NativeMediaTarget = {
  sourceId: string
}

export type NativeMediaSessionKind = 'screen'

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

export type NativeMediaSessionStartOptions = NativeMediaScreenSessionStartOptions

export type NativeMediaSession = {
  kind: NativeMediaSessionKind
  sessionId: string
  port: number
  streamMode: NativeMediaStreamMode
  encoder: NativeMediaEncoderBackend
  audio?: {
    mode: NativeMediaAudioMode
    port?: number
  }
}

export type NativeMediaSessionStatus =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running'; sessionId: string; port: number }
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
}

export type NativeMediaSidecarLostEvent = {
  sessionId: string
  reason: 'exit' | 'stream_error'
  message: string
}
