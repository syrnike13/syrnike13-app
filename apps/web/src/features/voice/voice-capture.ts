import {
  ScreenSharePresets,
  type AudioCaptureOptions,
  type RoomOptions,
  type TrackPublishOptions,
  type VideoEncoding,
} from 'livekit-client'

import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'

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

export function screenShareCaptureOptions(quality: ScreenShareQualityName) {
  const codec = readVoicePreferences().screenShareCodec
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
          audio: readVoicePreferences().screenShareAudio,
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
          audio: readVoicePreferences().screenShareAudio,
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
          audio: readVoicePreferences().screenShareAudio,
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
          audio: readVoicePreferences().screenShareAudio,
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
