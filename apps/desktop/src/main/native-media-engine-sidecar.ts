import type {
  DesktopDisplayMediaSource,
  NativeMediaAudioMode,
  NativeMediaEchoCancellationMode,
  NativeMediaDeviceInfo,
  NativeMediaEncoderBackend,
  NativeMediaFrameMethod,
  NativeMediaLoopbackMode,
  NativeMediaStateEvent,
  NativeMicrophoneMetricsEvent,
} from '@syrnike13/platform'

export type SidecarEvent =
  | {
      type: 'ready'
      port: number
      stream_mode?: string
      encoder?: string
      codec?: string
      width?: number
      height?: number
      fps?: number
      bitrate?: number
      frame_buffer_path?: string
      audio_port?: number
      audio_mode?: string
      audio_sample_rate?: number
      audio_channels?: number
      audio_target_process_id?: number
      audio_loopback_mode?: string
      echo_cancellation?: string
      native_participant_identity?: string
    }
  | {
      type: 'frame_method'
      method: string
      count: number
      active_method?: string
    }
  | { type: 'downgrade'; from: string; to: string; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'stopped' }
  | {
      type: 'device_list'
      devices: NativeMediaDeviceInfo[]
    }
  | {
      type: 'display_source_list'
      sources: DesktopDisplayMediaSource[]
    }
  | {
      type: 'screen_share_preflight'
      sourceId: string
      source_type?: 'screen' | 'window' | 'game'
      ok: boolean
      message?: string
      video?: {
        method: string
        captured: boolean
        width: number
        height: number
        fps: number
        duration_ms: number
        attempts: number
        captured_frames: number
        late_frames: number
        avg_capture_us: number
        bytes: number
      }
      audio?: {
        requested: boolean
        ok: boolean
        mode: string
        loopback_mode: string
        target_process_id: number
        peak_db?: number
        rms_db?: number
        sample_rate: number
        channels: number
      }
    }
  | {
      type: 'microphone_metrics'
      session_id: string
      input_db: number
      threshold_db: number
      open: boolean
    }
  | {
      type: 'session_lifecycle'
      session_id: string
      kind: 'screen' | 'microphone'
      status: 'starting' | 'running' | 'stopped' | 'error'
      port?: number
      audio_port?: number
      audio_mode?: string
      audio_sample_rate?: number
      audio_channels?: number
      audio_target_process_id?: number
      audio_loopback_mode?: string
      echo_cancellation?: string
      width?: number
      height?: number
      fps?: number
      bitrate?: number
      message?: string
    }
  | {
      type: 'track_published'
      session_id: string
      kind: 'audio' | 'video'
      source: string
      audio_mode?: string
      audio_sample_rate?: number
      audio_channels?: number
      audio_target_process_id?: number
      audio_loopback_mode?: string
    }
  | {
      type: 'screen_audio_frame'
      session_id: string
      frames: number
      packets: number
      peak_db?: number
      rms_db?: number
      sample_rate?: number
      channels?: number
      audio_mode?: string
      audio_loopback_mode?: string
      audio_target_process_id?: number
    }
  | {
      type: 'screen_video_frame'
      session_id: string
      frames: number
      interval_frames: number
      target_fps: number
      late_frames: number
      avg_capture_us: number
      method?: string
    }

export function parseSidecarEvent(line: string): SidecarEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const event = JSON.parse(trimmed) as SidecarEvent
    if (!event || typeof event !== 'object' || !('type' in event)) return null
    return event
  } catch {
    return null
  }
}

export function mapMicrophoneMetrics(
  event: Extract<SidecarEvent, { type: 'microphone_metrics' }>,
): NativeMicrophoneMetricsEvent {
  return {
    sessionId: event.session_id,
    inputDb: event.input_db,
    thresholdDb: event.threshold_db,
    open: event.open,
  }
}

export function mapFrameMethod(method: string): NativeMediaFrameMethod | null {
  switch (method) {
    case 'wgc':
      return 'wgc'
    case 'dxgi':
      return 'dxgi'
    case 'gdi_blt':
      return 'gdi_blt'
    case 'gdi_print':
      return 'gdi_print'
    default:
      return null
  }
}

export function mapEncoderBackend(
  value: string | undefined,
): NativeMediaEncoderBackend {
  if (value === 'webrtc') return 'webrtc'
  return value === 'media_foundation' ? 'media_foundation' : 'openh264'
}

export function mapAudioMode(value: string | undefined): NativeMediaAudioMode {
  if (value === 'process') return 'process'
  if (value === 'system_exclude') return 'system_exclude'
  if (value === 'microphone') return 'microphone'
  return 'none'
}

export function mapEchoCancellationMode(
  value: string | undefined,
): NativeMediaEchoCancellationMode | undefined {
  if (value === 'disabled') return 'disabled'
  if (value === 'windows') return 'windows'
  if (value === 'software') return 'software'
  if (value === 'unavailable') return 'unavailable'
  return undefined
}

export function mapLoopbackMode(
  value: string | undefined,
): NativeMediaLoopbackMode | undefined {
  if (value === 'include_target_process_tree') return 'include_target_process_tree'
  if (value === 'exclude_target_process_tree') return 'exclude_target_process_tree'
  return undefined
}

export function mapLifecycleState(
  event: Extract<SidecarEvent, { type: 'session_lifecycle' }>,
): NativeMediaStateEvent {
  switch (event.status) {
    case 'starting':
      return { status: 'starting', sessionId: event.session_id }
    case 'running':
      return {
        status: 'running',
        sessionId: event.session_id,
        port: event.port,
        width: event.width,
        height: event.height,
        fps: event.fps,
        bitrate: event.bitrate,
        audio:
          event.audio_mode || event.audio_port != null
            ? {
                mode: mapAudioMode(event.audio_mode),
                port: event.audio_port,
                sampleRate:
                  event.audio_sample_rate === 48_000 ? 48_000 : undefined,
                channels:
                  event.audio_channels === 1 || event.audio_channels === 2
                    ? event.audio_channels
                    : undefined,
                echoCancellation: mapEchoCancellationMode(event.echo_cancellation),
                targetProcessId:
                  typeof event.audio_target_process_id === 'number'
                    ? event.audio_target_process_id
                    : undefined,
                loopbackMode: mapLoopbackMode(event.audio_loopback_mode),
              }
            : undefined,
      }
    case 'error':
      return {
        status: 'error',
        sessionId: event.session_id,
        message: event.message ?? 'Native media engine session failed',
      }
    case 'stopped':
      return { status: 'idle', sessionId: event.session_id }
  }
}

