import {
  ScreenSharePresets,
  type RoomOptions,
  type VideoEncoding,
} from 'livekit-client'

import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'

export function createVoiceRoomOptions(): RoomOptions {
  const prefs = readVoicePreferences()

  return {
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      deviceId: prefs.preferredAudioInputDevice,
      channelCount: 1,
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
        encoding: {
          maxBitrate: 4_000_000,
          maxFramerate: 30,
          priority: 'high',
        } satisfies VideoEncoding,
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'motion' as const,
      }
    case 'high60':
      return {
        resolution: {
          ...ScreenSharePresets.h1080fps30.resolution,
          frameRate: 60,
        },
        encoding: {
          maxBitrate: 8_000_000,
          maxFramerate: 60,
          priority: 'high',
        } satisfies VideoEncoding,
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'motion' as const,
      }
    case 'text':
      return {
        resolution: {
          ...ScreenSharePresets.h1080fps30.resolution,
          frameRate: 5,
        },
        encoding: {
          maxBitrate: 2_000_000,
          maxFramerate: 5,
          priority: 'high',
        } satisfies VideoEncoding,
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'detail' as const,
      }
    case 'low':
    default:
      return {
        resolution: ScreenSharePresets.h720fps30.resolution,
        encoding: {
          maxBitrate: 2_500_000,
          maxFramerate: 30,
          priority: 'high',
        } satisfies VideoEncoding,
        audio: readVoicePreferences().screenShareAudio,
        contentHint: 'motion' as const,
      }
  }
}
