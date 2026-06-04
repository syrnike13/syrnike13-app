import { ScreenSharePresets, type RoomOptions } from 'livekit-client'

import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'

export function createVoiceRoomOptions(): RoomOptions {
  const prefs = readVoicePreferences()

  return {
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      deviceId: prefs.preferredAudioInputDevice,
      echoCancellation: prefs.echoCancellation,
      noiseSuppression: prefs.noiseSuppression === 'browser',
      autoGainControl: prefs.autoGainControl,
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
  switch (quality) {
    case 'high':
      return {
        resolution: ScreenSharePresets.h1080fps30.resolution,
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'motion' as const,
      }
    case 'high60':
      return {
        resolution: {
          ...ScreenSharePresets.h1080fps30.resolution,
          frameRate: 60,
        },
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'motion' as const,
      }
    case 'text':
      return {
        resolution: {
          ...ScreenSharePresets.original.resolution,
          frameRate: 5,
          aspectRatio: 0,
        },
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'detail' as const,
      }
    case 'low':
    default:
      return {
        resolution: ScreenSharePresets.h720fps30.resolution,
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'motion' as const,
      }
  }
}
