import { shouldUseNativeMicrophone } from '#/features/voice/native-microphone-publish'
import type { VoiceMicIssue } from '#/features/voice/voice-mic-status'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type VoiceMediaAvailability = {
  available: boolean
  /** Тултип при недоступности: «Микрофон недоступен». */
  title: string
}

export type VoiceMediaAvailabilityState = {
  microphone: VoiceMediaAvailability
  camera: VoiceMediaAvailability
  screenShare: VoiceMediaAvailability
}

function unavailable(label: string): VoiceMediaAvailability {
  return {
    available: false,
    title: label,
  }
}

function available(): VoiceMediaAvailability {
  return {
    available: true,
    title: '',
  }
}

export function hasDetectedMediaDevices(
  devices: readonly Pick<MediaDeviceInfo, 'kind'>[],
) {
  return devices.length > 0
}

export function isMicrophoneCaptureSupported() {
  if (shouldUseNativeMicrophone()) {
    return true
  }
  return typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export function isCameraCaptureSupported() {
  return typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export function isScreenShareCaptureSupported() {
  const desktop = getSyrnikeDesktop()
  if (desktop?.platform.os === 'win32') {
    return typeof desktop.media?.openDisplayPicker === 'function'
  }
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function resolveMicrophoneAvailability(options: {
  inputDevices: readonly MediaDeviceInfo[]
  micIssue: VoiceMicIssue | null
}): VoiceMediaAvailability {
  if (options.micIssue) {
    return unavailable('Микрофон недоступен')
  }

  if (!isMicrophoneCaptureSupported()) {
    return unavailable('Микрофон недоступен')
  }

  if (!hasDetectedMediaDevices(options.inputDevices)) {
    return unavailable('Микрофон недоступен')
  }

  return available()
}

export function resolveCameraAvailability(options: {
  videoDevices: readonly MediaDeviceInfo[]
}): VoiceMediaAvailability {
  if (!isCameraCaptureSupported()) {
    return unavailable('Камера недоступна')
  }

  if (!hasDetectedMediaDevices(options.videoDevices)) {
    return unavailable('Камера недоступна')
  }

  return available()
}

export function resolveScreenShareAvailability(): VoiceMediaAvailability {
  if (!isScreenShareCaptureSupported()) {
    return unavailable('Демонстрация недоступна')
  }

  return available()
}

export function buildVoiceMediaAvailabilityState(options: {
  inputDevices: readonly MediaDeviceInfo[]
  videoDevices: readonly MediaDeviceInfo[]
  micIssue: VoiceMicIssue | null
}): VoiceMediaAvailabilityState {
  return {
    microphone: resolveMicrophoneAvailability({
      inputDevices: options.inputDevices,
      micIssue: options.micIssue,
    }),
    camera: resolveCameraAvailability({
      videoDevices: options.videoDevices,
    }),
    screenShare: resolveScreenShareAvailability(),
  }
}

export function voiceMediaControlState(options: {
  availability: VoiceMediaAvailability
  active: boolean
  connecting?: boolean
  busy?: boolean
  activeTitle: string
  inactiveTitle: string
  busyTitle?: string
}) {
  const unavailable = !options.availability.available && !options.active

  const title = unavailable
    ? options.availability.title
    : options.busy && options.busyTitle
      ? options.busyTitle
      : options.active
        ? options.activeTitle
        : options.inactiveTitle

  const disabled =
    Boolean(options.connecting) ||
    Boolean(options.busy) ||
    unavailable

  return { disabled, title }
}

export function microphoneMediaControlState(options: {
  availability: VoiceMediaAvailability
  inVoice: boolean
  micMuted: boolean
  connecting?: boolean
}) {
  const unavailable = !options.availability.available && options.micMuted

  const title = unavailable
    ? options.availability.title
    : options.inVoice
      ? options.micMuted
        ? 'Включить микрофон'
        : 'Выключить микрофон'
      : options.micMuted
        ? 'Микрофон выключен (применится при входе в голос)'
        : 'Выключить микрофон до входа в голос'

  return {
    disabled: Boolean(options.connecting) || unavailable,
    title,
  }
}
