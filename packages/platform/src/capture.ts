/** Метод hybrid-захвата (счётчики как в Discord RTC debug). */
export type NativeCaptureFrameMethod =
  | 'wgc'
  | 'dxgi'
  | 'gdi_blt'
  | 'gdi_print'

export type NativeCaptureFrameStats = Record<NativeCaptureFrameMethod, number>

export type NativeCaptureStreamMode = 'h264' | 'bgra'

export type NativeCaptureEncoderBackend =
  | 'media_foundation'
  | 'openh264'

/** process = звук окна; system_exclude = системный вывод без Syrnike; none = звук недоступен. */
export type NativeCaptureAudioMode = 'process' | 'system_exclude' | 'none'

export type NativeCaptureTarget = {
  sourceId: string
}

export type NativeCaptureStartOptions = {
  sourceId: string
  width: number
  height: number
  fps: number
  bitrate: number
  streamMode?: NativeCaptureStreamMode
  withAudio?: boolean
}

export type NativeCaptureSession = {
  sessionId: string
  port: number
  streamMode: NativeCaptureStreamMode
  encoder: NativeCaptureEncoderBackend
  audioPort?: number
  audioMode?: NativeCaptureAudioMode
}

export type NativeCaptureState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running'; sessionId: string; port: number }
  | { status: 'error'; message: string }

export type NativeCaptureStatsEvent = {
  sessionId: string
  methods: NativeCaptureFrameStats
  activeMethod?: NativeCaptureFrameMethod
}

export type NativeCaptureStateEvent = NativeCaptureState & {
  sessionId?: string
}

export type NativeCaptureSidecarLostEvent = {
  sessionId: string
  reason: 'exit' | 'stream_error'
  message: string
}
