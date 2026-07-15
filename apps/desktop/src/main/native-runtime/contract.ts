import type {
  DesktopDisplayMediaSource,
  NativeInputEvent,
  NativeMediaDeviceInfo,
  NativeMediaMicrophoneSessionStartOptions,
  NativeMediaScreenSessionPrepareOptions,
  NativeMediaSession,
  NativeMediaSessionStartOptions,
  NativeMediaStateEvent,
  NativeMediaStatsEvent,
  NativeMicrophonePipelineConfig,
  NativeMicrophoneMetricsEvent,
  VoiceRemoteAudioSettings,
} from '@syrnike13/platform'
import { isVoiceRemoteAudioSettings } from '@syrnike13/platform'

export const NATIVE_RUNTIME_CONTRACT_VERSION = 3
export const NATIVE_RUNTIME_MAX_PENDING_REQUESTS = 256

export type NativeRuntimeKind = 'media' | 'hotkey' | 'overlay'

export type NativeRuntimeBuild = {
  commit?: string
  electron?: string
  napi?: string
  livekit?: string
}

export type NativeRuntimeReady = {
  type: 'ready'
  contractVersion: number
  runtime: NativeRuntimeKind | 'invalid'
  capabilities: string[]
  build: NativeRuntimeBuild
}

export type NativeRuntimeRequest = {
  type: 'request'
  requestId: string
  command: NativeRuntimeCommand
}

export type NativeRuntimeReply =
  | {
      type: 'reply'
      requestId: string
      ok: true
      result?: unknown
    }
  | {
      type: 'reply'
      requestId: string
      ok: false
      error: NativeRuntimeError
    }

export type NativeRuntimeEventMessage = {
  type: 'event'
  event: NativeRuntimeEvent
}

export type NativeRuntimeMessage =
  | NativeRuntimeReady
  | NativeRuntimeReply
  | NativeRuntimeEventMessage

export type NativeRuntimeError = {
  code: string
  message: string
  stage?: string
  retryable: boolean
  sessionId?: string
  generation?: number
}

type SessionCommandBase = {
  sessionId: string
  generation: number
}

export type MediaRuntimeCommand =
  | ({
      type: 'connectVoice'
      options: {
        livekit: {
          url: string
          token: string
          participantIdentity: string
        }
      }
    } & SessionCommandBase)
  | ({ type: 'disconnectVoice' } & SessionCommandBase)
  | ({ type: 'configureRemoteAudio'; settings: VoiceRemoteAudioSettings } &
      SessionCommandBase)
  | ({ type: 'releaseRemoteVideoFrame'; trackId: string; sequence: number } &
      SessionCommandBase)
  | ({ type: 'setRemoteVideoDemand'; trackId: string; demanded: boolean } &
      SessionCommandBase)
  | ({
      type: 'setLocalScreenPreviewDemand'
      demanded: boolean
      electronMainPid: number
      options: { width: number; height: number; fps: number }
    } & SessionCommandBase)
  | ({ type: 'releaseLocalScreenPreviewFrame'; trackId: string; sequence: number } &
      SessionCommandBase)
  | ({
      type: 'configureVoiceOutput'
      deafened: boolean
      deviceId?: string
      volume?: number
    } & SessionCommandBase)
  | {
      type: 'warmMicrophone'
      generation: number
      config: NativeMicrophonePipelineConfig
    }
  | {
      type: 'listDevices'
      kind: 'audioinput' | 'audiooutput' | 'videoinput'
    }
  | {
      type: 'listDisplaySources'
      selfWindowHwnd?: string
    }
  | ({ type: 'startPreview' } & SessionCommandBase)
  | ({ type: 'stopPreview' } & Partial<SessionCommandBase>)
  | ({ type: 'connectScreen'; options: NativeMediaScreenSessionPrepareOptions } &
      SessionCommandBase)
  | {
      type: 'disconnectScreen'
      generation: number
      sessionId?: string
      terminal?: boolean
    }
  | ({
      type: 'connectMicrophone'
      options: NativeMediaMicrophoneSessionStartOptions
      excludeProcessId: number
    } & SessionCommandBase)
  | ({
      type: 'startScreenCapture'
      options: Extract<NativeMediaSessionStartOptions, { kind: 'screen' }>
      selfWindowHwnd?: string
      excludeProcessId: number
    } & SessionCommandBase)
  | ({ type: 'disconnectMicrophone' } & SessionCommandBase)
  | ({
      type: 'connectCamera'
      options: {
        deviceId?: string
        width?: number
        height?: number
        fps?: number
        bitrate?: number
        livekit: {
          url: string
          token: string
          participantIdentity: string
        }
      }
    } & SessionCommandBase)
  | ({ type: 'disconnectCamera' } & SessionCommandBase)
  | ({ type: 'invalidateMicrophone' } & SessionCommandBase)
  | ({ type: 'stopScreenCapture' } & SessionCommandBase)
  | {
      type: 'configureMicrophone'
      revision: number
      config: NativeMicrophonePipelineConfig
    }
  | ({ type: 'setMicrophoneMuted'; muted: boolean } & SessionCommandBase)
  | { type: 'probeMicrophoneActor' }
  | { type: 'probeScreenActor' }
  | { type: 'probeQueryWorker' }
  | { type: 'shutdown' }

export type HooksRuntimeCommand =
  | { type: 'startHotkeys' }
  | { type: 'stopHotkeys' }
  | { type: 'startOverlay' }
  | { type: 'stopOverlay' }
  | { type: 'probeHooksRuntime' }
  | { type: 'shutdown' }

export type NativeRuntimeCommand = MediaRuntimeCommand | HooksRuntimeCommand

type RuntimeEventBase = {
  sequence: number
}

type SessionEventBase = RuntimeEventBase & {
  sessionId: string
  generation: number
  requestId?: string
}

export type OverlayForegroundWindow = {
  pid: number
  processName: string
  processPath: string | null
  title: string
  className: string
  visible: boolean
  fullscreenLike: boolean
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type MediaRuntimeEvent =
  | ({
      type: 'sessionLifecycle'
      kind?: 'voice' | 'microphone' | 'screen' | 'camera' | 'output'
      state: NativeMediaStateEvent
    } & SessionEventBase)
  | ({ type: 'sessionStarted'; session: NativeMediaSession } & SessionEventBase)
  | ({ type: 'sessionStopped'; reason?: string } & SessionEventBase)
  | ({ type: 'stats'; stats: NativeMediaStatsEvent } & SessionEventBase)
  | ({ type: 'microphoneMetrics'; metrics: NativeMicrophoneMetricsEvent } &
      RuntimeEventBase)
  | ({ type: 'microphonePreviewStarted'; preview: { sessionId: string } } &
      SessionEventBase)
  | ({ type: 'deviceList'; devices: NativeMediaDeviceInfo[] } & RuntimeEventBase)
  | ({ type: 'displaySourceList'; sources: DesktopDisplayMediaSource[] } &
      RuntimeEventBase)
  | ({ type: 'screenCaptureEnded'; reason: string; message?: string } &
      SessionEventBase)
  | ({ type: 'voiceTerminal'; error: NativeRuntimeError } & SessionEventBase)
  | ({ type: 'cameraTerminal'; error: NativeRuntimeError } & SessionEventBase)
  | ({ type: 'activeSpeakers'; participantIdentities: string[] } &
      SessionEventBase)
  | ({
      type: 'remoteVideoFrame'
      trackId: string
      participantIdentity: string
      source: 'camera' | 'screen'
      frameSequence: number
      timestampUs: number
      width: number
      height: number
      ntHandle: Uint8Array
    } & SessionEventBase)
  | ({ type: 'remoteVideoTrackRemoved'; trackId: string } & SessionEventBase)
  | ({ type: 'remoteVideoFailed'; trackId: string; source?: 'camera' | 'screen' } &
      SessionEventBase)
  | ({
      type: 'localScreenPreviewFrame'
      trackId: string
      participantIdentity: string
      source: 'screen'
      frameSequence: number
      timestampUs: number
      width: number
      height: number
      ntHandle: Uint8Array
    } & SessionEventBase)
  | ({ type: 'localScreenPreviewTrackRemoved'; trackId: string; source: 'screen' } &
      SessionEventBase)
  | ({ type: 'localScreenPreviewFailed'; trackId: string; error: NativeRuntimeError } &
      SessionEventBase)
  | ({ type: 'runtimeError'; error: NativeRuntimeError } & RuntimeEventBase)

export type HooksRuntimeEvent =
  | ({ type: 'input'; input: NativeInputEvent } & RuntimeEventBase)
  | ({ type: 'foregroundWindow'; window: OverlayForegroundWindow } &
      RuntimeEventBase)
  | ({ type: 'runtimeError'; error: NativeRuntimeError } & RuntimeEventBase)

export type NativeRuntimeEvent = MediaRuntimeEvent | HooksRuntimeEvent

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown, maxLength = 4_096): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  )
}

function isRuntimeError(value: unknown): value is NativeRuntimeError {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.code, 128) &&
    isNonEmptyString(value.message) &&
    typeof value.retryable === 'boolean' &&
    (value.stage === undefined || isNonEmptyString(value.stage, 128)) &&
    (value.sessionId === undefined || isNonEmptyString(value.sessionId, 256)) &&
    (value.generation === undefined ||
      (Number.isSafeInteger(value.generation) && Number(value.generation) >= 0))
  )
}

function isSequence(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isFiniteNumber(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isIntegerInRange(value: unknown, min: number, max: number) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}

function isUnsignedIntegerString(value: unknown) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value)) {
    return false
  }
  try {
    return BigInt(value) <= 0xffff_ffff_ffff_ffffn
  } catch {
    return false
  }
}

function isSessionCommand(value: Record<string, unknown>) {
  return (
    isNonEmptyString(value.sessionId, 256) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0
  )
}

function isLiveKitCredentials(value: unknown) {
  if (!isRecord(value)) return false
  if (
    !isNonEmptyString(value.url, 2_048) ||
    !isNonEmptyString(value.token, 32_768) ||
    !isNonEmptyString(value.participantIdentity, 512)
  ) {
    return false
  }
  try {
    const protocol = new URL(value.url).protocol
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

function isMicrophonePipelineConfig(
  value: unknown,
): value is NativeMicrophonePipelineConfig {
  if (!isRecord(value)) return false
  return (
    (value.deviceId === null || isNonEmptyString(value.deviceId, 2_048)) &&
    typeof value.bypassSystemAudioInputProcessing === 'boolean' &&
    typeof value.automaticGainControl === 'boolean' &&
    typeof value.noiseSuppression === 'boolean' &&
    typeof value.echoCancellation === 'boolean' &&
    isFiniteNumber(value.inputVolume, 0, 4) &&
    typeof value.voiceGateEnabled === 'boolean' &&
    isFiniteNumber(value.voiceGateThresholdDb, -100, 0) &&
    typeof value.voiceGateAutoThreshold === 'boolean'
  )
}

function isMicrophoneStartOptions(
  value: unknown,
): value is NativeMediaMicrophoneSessionStartOptions {
  if (!isRecord(value) || value.kind !== 'microphone') return false
  return (
    isNonEmptyString(value.requestId, 256) &&
    (value.audioBitrate === undefined || isIntegerInRange(value.audioBitrate, 6_000, 512_000)) &&
    (value.muted === undefined || typeof value.muted === 'boolean') &&
    isLiveKitCredentials(value.livekit)
  )
}

function isCameraStartOptions(value: unknown) {
  if (!isRecord(value) || !isLiveKitCredentials(value.livekit)) return false
  return (
    (value.deviceId === undefined || isNonEmptyString(value.deviceId, 2_048)) &&
    (value.width === undefined || isIntegerInRange(value.width, 16, 7_680)) &&
    (value.height === undefined || isIntegerInRange(value.height, 16, 4_320)) &&
    (value.fps === undefined || isIntegerInRange(value.fps, 1, 240)) &&
    (value.bitrate === undefined ||
      isIntegerInRange(value.bitrate, 32_000, 100_000_000))
  )
}

function isScreenStartOptions(value: unknown) {
  if (!isRecord(value) || value.kind !== 'screen') return false
  return (
    isNonEmptyString(value.requestId, 256) &&
    isNonEmptyString(value.sourceId, 2_048) &&
    isIntegerInRange(value.width, 64, 7_680) &&
    isIntegerInRange(value.height, 64, 4_320) &&
    isIntegerInRange(value.fps, 1, 240) &&
    isIntegerInRange(value.bitrate, 32_000, 100_000_000) &&
    (value.audioBitrate === undefined || isIntegerInRange(value.audioBitrate, 6_000, 512_000)) &&
    (value.audio === undefined ||
      (isRecord(value.audio) && typeof value.audio.requested === 'boolean')) &&
    isLiveKitCredentials(value.livekit)
  )
}

function isNoiseSuppressionMode(value: unknown) {
  return value === 'disabled' || value === 'software' || value === 'unavailable'
}

function isEchoCancellationMode(value: unknown) {
  return value === 'disabled' || value === 'software' || value === 'unavailable'
}

function isScreenAudioMode(value: unknown) {
  return value === 'process' || value === 'system_exclude' || value === 'none'
}

function isOptionalInteger(
  value: unknown,
  min: number,
  max: number,
) {
  return value === undefined || isIntegerInRange(value, min, max)
}

export function isNativeMediaSession(value: unknown): value is NativeMediaSession {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sessionId, 256) ||
    (value.kind !== 'microphone' && value.kind !== 'screen')
  ) {
    return false
  }
  if (value.kind === 'microphone') {
    return (
      isRecord(value.audio) &&
      value.audio.mode === 'microphone' &&
      value.audio.sampleRate === 48_000 &&
      value.audio.channels === 1 &&
      isNoiseSuppressionMode(value.audio.noiseSuppression) &&
      isEchoCancellationMode(value.audio.echoCancellation) &&
      isNonEmptyString(value.nativeParticipantIdentity, 512)
    )
  }
  if (value.encoder !== 'mf_h264_d3d11') return false
  if (
    !isOptionalInteger(value.width, 16, 7_680) ||
    !isOptionalInteger(value.height, 16, 4_320) ||
    !isOptionalInteger(value.fps, 1, 240) ||
    !isOptionalInteger(value.bitrate, 32_000, 100_000_000)
  ) {
    return false
  }
  if (value.audio !== undefined) {
    if (!isRecord(value.audio) || !isScreenAudioMode(value.audio.mode)) return false
    if (
      !isOptionalInteger(value.audio.targetProcessId, 0, 0xffff_ffff) ||
      (value.audio.loopbackMode !== undefined &&
        value.audio.loopbackMode !== 'include_target_process_tree' &&
        value.audio.loopbackMode !== 'exclude_target_process_tree')
    ) {
      return false
    }
  }
  return (
    value.nativeParticipantIdentity === undefined ||
    isNonEmptyString(value.nativeParticipantIdentity, 512)
  )
}

function isNativeMediaStateEvent(value: unknown, sessionId: string) {
  if (!isRecord(value)) return false
  if (value.sessionId !== undefined && value.sessionId !== sessionId) return false
  if (
    !isOptionalInteger(value.width, 16, 7_680) ||
    !isOptionalInteger(value.height, 16, 4_320) ||
    !isOptionalInteger(value.fps, 1, 240) ||
    !isOptionalInteger(value.bitrate, 32_000, 100_000_000)
  ) {
    return false
  }
  if (value.audio !== undefined) {
    if (!isRecord(value.audio)) return false
    const audioMode = value.audio.mode
    if (audioMode !== 'microphone' && !isScreenAudioMode(audioMode)) return false
  }
  switch (value.status) {
    case 'idle':
    case 'starting':
      return true
    case 'running':
      return value.sessionId === sessionId
    case 'error':
      return isNonEmptyString(value.message)
    default:
      return false
  }
}

function isNativeMediaStats(value: unknown, sessionId: string) {
  if (!isRecord(value) || value.sessionId !== sessionId || !isRecord(value.methods)) {
    return false
  }
  const methods = value.methods
  if (
    !(['wgc_gpu', 'dxgi_gpu'] as const).every(
      (method) => isFiniteNumber(methods[method], 0, Number.MAX_SAFE_INTEGER),
    ) ||
    (value.activeMethod !== undefined &&
      value.activeMethod !== 'wgc_gpu' &&
      value.activeMethod !== 'dxgi_gpu')
  ) {
    return false
  }
  const numericFields = [
    'audioFrames',
    'audioPackets',
    'audioPeakDb',
    'audioRmsDb',
    'videoFrames',
    'videoIntervalFrames',
    'videoLateFrames',
    'videoNoFrameCount',
    'videoRepeatedFrameCount',
    'videoRecoverableLostCount',
    'videoAvgCaptureUs',
    'videoAvgReadbackUs',
    'videoAvgScaleUs',
    'videoAvgPublishUs',
    'videoSourceWidth',
    'videoSourceHeight',
    'videoContentWidth',
    'videoContentHeight',
  ] as const
  if (
    numericFields.some(
      (field) => value[field] !== undefined && !Number.isFinite(value[field]),
    )
  ) {
    return false
  }
  return (
    (value.publishedVideo === undefined || typeof value.publishedVideo === 'boolean') &&
    (value.publishedAudio === undefined || typeof value.publishedAudio === 'boolean') &&
    (value.captureThreadMmcss === undefined ||
      typeof value.captureThreadMmcss === 'boolean')
  )
}

export function isNativeRuntimeCommand(value: unknown): value is NativeRuntimeCommand {
  if (!isRecord(value) || !isNonEmptyString(value.type, 128)) return false
  switch (value.type) {
    case 'connectVoice':
      return (
        isSessionCommand(value) &&
        isRecord(value.options) &&
        isLiveKitCredentials(value.options.livekit)
      )
    case 'disconnectVoice':
      return isSessionCommand(value)
    case 'configureRemoteAudio':
      return isSessionCommand(value) && isVoiceRemoteAudioSettings(value.settings)
    case 'releaseRemoteVideoFrame':
      return isSessionCommand(value) && isNonEmptyString(value.trackId, 512) &&
        isSequence(value.sequence)
    case 'setRemoteVideoDemand':
      return isSessionCommand(value) && isNonEmptyString(value.trackId, 512) &&
        typeof value.demanded === 'boolean'
    case 'setLocalScreenPreviewDemand':
      return isSessionCommand(value) && typeof value.demanded === 'boolean' &&
        isIntegerInRange(value.electronMainPid, 1, 0xffff_ffff) &&
        isRecord(value.options) && isIntegerInRange(value.options.width, 16, 3840) &&
        isIntegerInRange(value.options.height, 16, 2160) &&
        isIntegerInRange(value.options.fps, 1, 60)
    case 'releaseLocalScreenPreviewFrame':
      return isSessionCommand(value) && isNonEmptyString(value.trackId, 512) &&
        isSequence(value.sequence)
    case 'configureVoiceOutput':
      return (
        isSessionCommand(value) &&
        typeof value.deafened === 'boolean' &&
        (value.volume === undefined || isFiniteNumber(value.volume, 0, 3)) &&
        (value.deviceId === undefined || isNonEmptyString(value.deviceId, 2_048))
      )
    case 'warmMicrophone':
      return (
        Number.isSafeInteger(value.generation) &&
        Number(value.generation) >= 0 &&
        isMicrophonePipelineConfig(value.config)
      )
    case 'listDevices':
      return (
        value.kind === 'audioinput' ||
        value.kind === 'audiooutput' ||
        value.kind === 'videoinput'
      )
    case 'listDisplaySources':
      return value.selfWindowHwnd === undefined || isUnsignedIntegerString(value.selfWindowHwnd)
    case 'startPreview':
      return isSessionCommand(value)
    case 'stopPreview':
      return (
        (value.sessionId === undefined || isNonEmptyString(value.sessionId, 256)) &&
        (value.generation === undefined ||
          (Number.isSafeInteger(value.generation) && Number(value.generation) >= 0))
      )
    case 'connectScreen':
      return (
        isSessionCommand(value) &&
        isRecord(value.options) &&
        isLiveKitCredentials(value.options.livekit)
      )
    case 'disconnectScreen':
      return (
        Number.isSafeInteger(value.generation) &&
        Number(value.generation) >= 0 &&
        (value.sessionId === undefined || isNonEmptyString(value.sessionId, 256)) &&
        (value.terminal === undefined || typeof value.terminal === 'boolean')
      )
    case 'connectMicrophone':
      return (
        isSessionCommand(value) &&
        isMicrophoneStartOptions(value.options) &&
        isIntegerInRange(value.excludeProcessId, 0, 0xffff_ffff)
      )
    case 'startScreenCapture':
      return (
        isSessionCommand(value) &&
        isScreenStartOptions(value.options) &&
        isIntegerInRange(value.excludeProcessId, 0, 0xffff_ffff) &&
        (value.selfWindowHwnd === undefined || isUnsignedIntegerString(value.selfWindowHwnd))
      )
    case 'disconnectMicrophone':
    case 'invalidateMicrophone':
    case 'stopScreenCapture':
      return isSessionCommand(value)
    case 'connectCamera':
      return isSessionCommand(value) && isCameraStartOptions(value.options)
    case 'disconnectCamera':
      return isSessionCommand(value)
    case 'configureMicrophone':
      return (
        Number.isSafeInteger(value.revision) &&
        Number(value.revision) >= 0 &&
        isMicrophonePipelineConfig(value.config)
      )
    case 'setMicrophoneMuted':
      return isSessionCommand(value) && typeof value.muted === 'boolean'
    case 'probeMicrophoneActor':
    case 'probeScreenActor':
    case 'probeQueryWorker':
    case 'startHotkeys':
    case 'stopHotkeys':
    case 'startOverlay':
    case 'stopOverlay':
    case 'probeHooksRuntime':
    case 'shutdown':
      return true
    default:
      return false
  }
}

export function isNativeRuntimeRequest(value: unknown): value is NativeRuntimeRequest {
  if (!isRecord(value)) return false
  return (
    value.type === 'request' &&
    isNonEmptyString(value.requestId, 256) &&
    isNativeRuntimeCommand(value.command)
  )
}

export function isNativeRuntimeReady(value: unknown): value is NativeRuntimeReady {
  if (!isRecord(value) || value.type !== 'ready') return false
  if (
    value.runtime !== 'media' &&
    value.runtime !== 'hotkey' &&
    value.runtime !== 'overlay' &&
    value.runtime !== 'invalid'
  ) {
    return false
  }
  return (
    Number.isSafeInteger(value.contractVersion) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 32 &&
    value.capabilities.every((capability) => isNonEmptyString(capability, 128)) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    isRecord(value.build) &&
    Object.values(value.build).every(
      (item) => item === undefined || typeof item === 'string',
    )
  )
}

export function isNativeRuntimeReply(value: unknown): value is NativeRuntimeReply {
  if (
    !isRecord(value) ||
    value.type !== 'reply' ||
    !isNonEmptyString(value.requestId, 256) ||
    typeof value.ok !== 'boolean'
  ) {
    return false
  }
  return value.ok || isRuntimeError(value.error)
}

export function isNativeRuntimeEvent(
  value: unknown,
): value is NativeRuntimeEvent {
  if (!isRecord(value) || !isNonEmptyString(value.type, 128)) return false
  if (!isSequence(value.sequence)) return false

  if (value.type === 'input') {
    if (!isRecord(value.input)) return false
    return (
      (value.input.type === 'inputDown' || value.input.type === 'inputUp') &&
      (value.input.source === 'keyboard' || value.input.source === 'mouse') &&
      isNonEmptyString(value.input.code, 128) &&
      typeof value.input.label === 'string' &&
      value.input.label.length <= 512 &&
      Array.isArray(value.input.pressedCodes) &&
      value.input.pressedCodes.length <= 64 &&
      value.input.pressedCodes.every((code) => isNonEmptyString(code, 128))
    )
  }
  if (value.type === 'foregroundWindow') {
    if (!isRecord(value.window) || !isRecord(value.window.bounds)) return false
    const window = value.window
    const bounds = window.bounds as Record<string, unknown>
    return (
      Number.isSafeInteger(window.pid) &&
      typeof window.processName === 'string' && window.processName.length <= 4_096 &&
      (window.processPath === null ||
        (typeof window.processPath === 'string' && window.processPath.length <= 32_768)) &&
      typeof window.title === 'string' && window.title.length <= 32_768 &&
      typeof window.className === 'string' && window.className.length <= 4_096 &&
      typeof window.visible === 'boolean' &&
      typeof window.fullscreenLike === 'boolean' &&
      (['x', 'y', 'width', 'height'] as const).every((key) =>
        Number.isFinite(bounds[key]),
      )
    )
  }
  if (value.type === 'runtimeError') {
    if (!isRuntimeError(value.error)) return false
    return (
      (value.sessionId === undefined || value.sessionId === value.error.sessionId) &&
      (value.generation === undefined || value.generation === value.error.generation)
    )
  }
  if (value.type === 'voiceTerminal' || value.type === 'cameraTerminal') {
    return (
      isRuntimeError(value.error) &&
      isNonEmptyString(value.sessionId, 256) &&
      Number.isSafeInteger(value.generation) &&
      Number(value.generation) >= 0 &&
      value.error.sessionId === value.sessionId &&
      value.error.generation === value.generation
    )
  }
  if (value.type === 'deviceList') {
    return (
      Array.isArray(value.devices) &&
      value.devices.every(
        (device) =>
          isRecord(device) &&
          isNonEmptyString(device.deviceId, 2_048) &&
          (device.kind === 'audioinput' ||
            device.kind === 'audiooutput' ||
            device.kind === 'videoinput') &&
          typeof device.label === 'string' &&
          device.label.length <= 4_096,
      )
    )
  }
  if (value.type === 'displaySourceList') {
    return (
      Array.isArray(value.sources) &&
      value.sources.every(
        (source) =>
          isRecord(source) &&
          isNonEmptyString(source.id, 2_048) &&
          typeof source.name === 'string' &&
          source.name.length <= 32_768 &&
          (source.type === 'screen' || source.type === 'window' || source.type === 'game'),
      )
    )
  }
  if (value.type === 'microphoneMetrics') {
    return (
      isRecord(value.metrics) &&
      Number.isFinite(value.metrics.inputDb) &&
      Number.isFinite(value.metrics.thresholdDb) &&
      typeof value.metrics.open === 'boolean'
    )
  }

  if (
    !isNonEmptyString(value.sessionId, 256) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0
  ) {
    return false
  }
  if (value.requestId !== undefined && !isNonEmptyString(value.requestId, 256)) {
    return false
  }

  switch (value.type) {
    case 'sessionLifecycle':
      return (
        (value.kind === undefined ||
          value.kind === 'voice' ||
          value.kind === 'microphone' ||
          value.kind === 'screen' ||
          value.kind === 'camera' ||
          value.kind === 'output') &&
        isNativeMediaStateEvent(value.state, value.sessionId)
      )
    case 'sessionStarted':
      return (
        isNativeMediaSession(value.session) &&
        value.session.sessionId === value.sessionId
      )
    case 'sessionStopped':
      return value.reason === undefined || typeof value.reason === 'string'
    case 'stats':
      return isNativeMediaStats(value.stats, value.sessionId)
    case 'microphonePreviewStarted':
      return (
        isRecord(value.preview) &&
        value.preview.sessionId === value.sessionId &&
        isNonEmptyString(value.preview.sessionId, 256)
      )
    case 'activeSpeakers':
      return (
        Array.isArray(value.participantIdentities) &&
        value.participantIdentities.length <= 512 &&
        value.participantIdentities.every((identity) =>
          isNonEmptyString(identity, 512),
        )
      )
    case 'remoteVideoFrame':
    case 'localScreenPreviewFrame':
      return (
        isNonEmptyString(value.trackId, 512) &&
        typeof value.participantIdentity === 'string' && value.participantIdentity.length <= 512 &&
        (value.type === 'localScreenPreviewFrame'
          ? value.source === 'screen'
          : value.source === 'camera' || value.source === 'screen') &&
        isSequence(value.frameSequence) && isSequence(value.timestampUs) &&
        isIntegerInRange(value.width, 1, 7680) &&
        isIntegerInRange(value.height, 1, 4320) &&
        value.ntHandle instanceof Uint8Array && value.ntHandle.byteLength === 8
      )
    case 'remoteVideoTrackRemoved':
      return isNonEmptyString(value.trackId, 512)
    case 'localScreenPreviewTrackRemoved':
      return isNonEmptyString(value.trackId, 512) && value.source === 'screen'
    case 'localScreenPreviewFailed':
      return isNonEmptyString(value.trackId, 512) && isRuntimeError(value.error) &&
        value.error.code === 'LOCAL_SCREEN_PREVIEW_FAILED' &&
        value.error.sessionId === value.sessionId &&
        value.error.generation === value.generation
    case 'remoteVideoFailed':
      return isNonEmptyString(value.trackId, 512) &&
        (value.source === undefined || value.source === 'camera' || value.source === 'screen')
    case 'screenCaptureEnded':
      return (
        isNonEmptyString(value.reason, 256) &&
        (value.message === undefined ||
          (typeof value.message === 'string' && value.message.length <= 4_096))
      )
    default:
      return false
  }
}

export function isNativeRuntimeMessage(
  value: unknown,
): value is NativeRuntimeMessage {
  if (isNativeRuntimeReady(value) || isNativeRuntimeReply(value)) return true
  return (
    isRecord(value) &&
    value.type === 'event' &&
    isNativeRuntimeEvent(value.event)
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
  }
}

export function sanitizeRuntimeError(error: unknown): NativeRuntimeError {
  if (isRuntimeError(error)) {
    return {
      ...error,
      message: redactSensitiveText(error.message),
      stage: error.stage ? redactSensitiveText(error.stage).slice(0, 128) : undefined,
    }
  }
  const message = error instanceof Error ? error.message : 'Native runtime failed'
  return nativeRuntimeError('native_failure', redactSensitiveText(message))
}

export function redactSensitiveText(value: string) {
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
    .slice(0, 4_096)
}
