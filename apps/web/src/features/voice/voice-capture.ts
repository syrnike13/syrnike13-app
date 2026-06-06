import {
  ScreenSharePresets,
  type AudioCaptureOptions,
  type RoomOptions,
  type TrackPublishOptions,
  type VideoEncoding,
} from 'livekit-client'

import type {
  ScreenShareCodec,
  ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

function browserNoiseSuppressionEnabled(prefs: VoicePreferenceState) {
  if (prefs.noiseSuppression === 'disabled') return false
  if (prefs.noiseSuppression === 'browser') return true
  return prefs.voiceGateEnabled
}

export function voiceAudioProcessingConstraints(
  prefs: VoicePreferenceState,
): AudioCaptureOptions {
  return {
    channelCount: 1,
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: browserNoiseSuppressionEnabled(prefs),
    autoGainControl: prefs.autoGainControl,
  }
}

export function createVoiceRoomOptions(): RoomOptions {
  const prefs = readVoicePreferences()

  return {
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      ...voiceAudioProcessingConstraints(prefs),
      deviceId: prefs.preferredAudioInputDevice,
    },
    audioOutput: {
      deviceId: prefs.preferredAudioOutputDevice,
    },
    videoCaptureDefaults: {
      deviceId: prefs.preferredVideoDevice,
    },
  }
}

type RtpVideoCodec = 'vp8' | 'h264' | 'vp9' | 'av1'

const AUTO_CODEC_PRIORITY = {
  low: ['vp9', 'h264', 'vp8'],
  high: ['vp9', 'h264', 'vp8'],
  high60: ['h264', 'vp9', 'vp8'],
  text: ['vp9', 'h264', 'vp8'],
} as const satisfies Record<ScreenShareQualityName, readonly RtpVideoCodec[]>

function supportedVideoCodecs() {
  const capabilities = globalThis.RTCRtpSender?.getCapabilities?.('video')
  const codecs = capabilities?.codecs ?? []

  return new Set(
    codecs
      .map((codec) => codec.mimeType.toLowerCase())
      .map((mimeType) => mimeType.match(/^video\/([^;]+)/)?.[1])
      .filter((codec): codec is RtpVideoCodec =>
        codec === 'vp8' || codec === 'h264' || codec === 'vp9' || codec === 'av1',
      ),
  )
}

export function isAv1ScreenShareSupported() {
  return supportedVideoCodecs().has('av1')
}

function isWindowsDesktopRuntime() {
  return getSyrnikeDesktop()?.platform.os === 'win32'
}

function selectScreenShareCodec(
  quality: ScreenShareQualityName,
  preference: ScreenShareCodec,
): RtpVideoCodec {
  const supported = supportedVideoCodecs()
  if (supported.size === 0) return 'vp8'

  if (preference === 'av1' && supported.has('av1')) {
    return 'av1'
  }

  if (
    isWindowsDesktopRuntime() &&
    (quality === 'high' || quality === 'high60') &&
    supported.has('h264')
  ) {
    return 'h264'
  }

  return (
    AUTO_CODEC_PRIORITY[quality].find((codec) => supported.has(codec)) ?? 'vp8'
  )
}

export function screenShareCaptureOptions(quality: ScreenShareQualityName) {
  const prefs = readVoicePreferences()
  const codec = selectScreenShareCodec(quality, prefs.screenShareCodec)
  const publish = (screenShareEncoding: VideoEncoding): TrackPublishOptions => ({
    screenShareEncoding,
    simulcast: false,
    videoCodec: codec,
    degradationPreference: 'maintain-resolution',
  })

  switch (quality) {
    case 'high':
      return {
        capture: {
          resolution: ScreenSharePresets.h1080fps30.resolution,
          audio: prefs.screenShareAudio,
          contentHint: 'motion' as const,
        },
        publish: publish({
          maxBitrate: 4_000_000,
          maxFramerate: 30,
          priority: 'high',
        }),
      }
    case 'high60':
      return {
        capture: {
          resolution: {
            ...ScreenSharePresets.h1080fps30.resolution,
            frameRate: 60,
          },
          audio: prefs.screenShareAudio,
          contentHint: 'motion' as const,
        },
        publish: publish({
          maxBitrate: 8_000_000,
          maxFramerate: 60,
          priority: 'high',
        }),
      }
    case 'text':
      return {
        capture: {
          resolution: {
            ...ScreenSharePresets.h1080fps30.resolution,
            frameRate: 5,
          },
          audio: prefs.screenShareAudio,
          contentHint: 'text' as const,
        },
        publish: publish({
          maxBitrate: 2_000_000,
          maxFramerate: 5,
          priority: 'high',
        }),
      }
    case 'low':
    default:
      return {
        capture: {
          resolution: ScreenSharePresets.h720fps30.resolution,
          audio: prefs.screenShareAudio,
          contentHint: 'motion' as const,
        },
        publish: publish({
          maxBitrate: 2_500_000,
          maxFramerate: 30,
          priority: 'high',
        }),
      }
  }
}
