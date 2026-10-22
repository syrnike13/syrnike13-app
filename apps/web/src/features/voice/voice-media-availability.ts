import type { Translator } from '@syrnike13/ui/i18n'

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

export function resolveMicrophoneAvailability(
  options: {
    inputDevices: readonly MediaDeviceInfo[]
    micIssue: VoiceMicIssue | null
  },
  t: Translator,
): VoiceMediaAvailability {
  if (options.micIssue) {
    return unavailable(t('micUnavailable'))
  }

  if (!isMicrophoneCaptureSupported()) {
    return unavailable(t('micUnavailable'))
  }

  if (!hasDetectedMediaDevices(options.inputDevices)) {
    return unavailable(t('micUnavailable'))
  }

  return available()
}

export function resolveCameraAvailability(
  options: {
    videoDevices: readonly MediaDeviceInfo[]
  },
  t: Translator,
): VoiceMediaAvailability {
  if (!isCameraCaptureSupported()) {
    return unavailable(t('cameraUnavailable'))
  }

  if (!hasDetectedMediaDevices(options.videoDevices)) {
    return unavailable(t('cameraUnavailable'))
  }

  return available()
}

export function resolveScreenShareAvailability(
  t: Translator,
): VoiceMediaAvailability {
  if (!isScreenShareCaptureSupported()) {
    return unavailable(t('screenShareUnavailable'))
  }

  return available()
}

export function buildVoiceMediaAvailabilityState(
  options: {
    inputDevices: readonly MediaDeviceInfo[]
    videoDevices: readonly MediaDeviceInfo[]
    micIssue: VoiceMicIssue | null
  },
  t: Translator,
): VoiceMediaAvailabilityState {
  return {
    microphone: resolveMicrophoneAvailability(
      {
        inputDevices: options.inputDevices,
        micIssue: options.micIssue,
      },
      t,
    ),
    camera: resolveCameraAvailability(
      {
        videoDevices: options.videoDevices,
      },
      t,
    ),
    screenShare: resolveScreenShareAvailability(t),
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

export function microphoneMediaControlState(
  options: {
    availability: VoiceMediaAvailability
    inVoice: boolean
    micMuted: boolean
    connecting?: boolean
  },
  t: Translator,
) {
  const unavailable = !options.availability.available && options.micMuted

  const title = unavailable
    ? options.availability.title
    : options.micMuted
      ? t('enableMic')
      : t('disableMic')

  return {
    disabled: Boolean(options.connecting) || unavailable,
    title,
  }
}
