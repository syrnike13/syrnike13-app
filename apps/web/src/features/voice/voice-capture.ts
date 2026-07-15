import {
  AudioPresets,
  ScreenSharePresets,
  Track,
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
  clampVoiceChannelAudioBitrateKbps,
  DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
} from '#/lib/channel-audio-bitrate'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

function audioPresetWithBitrate<T extends { maxBitrate?: number }>(
  preset: T,
  bitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
) {
  return {
    ...preset,
    maxBitrate: clampVoiceChannelAudioBitrateKbps(bitrateKbps) * 1000,
  }
}

export function voiceMicPublishOptions(
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
): TrackPublishOptions {
  return {
    source: Track.Source.Microphone,
    audioPreset: audioPresetWithBitrate(AudioPresets.speech, audioBitrateKbps),
    dtx: true,
  }
}

export function screenShareAudioCaptureOptions(
  enabled: boolean,
): boolean | AudioCaptureOptions {
  if (!enabled) return false
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  }
}

export function screenShareAudioPublishOptions(
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
): TrackPublishOptions {
  return {
    source: Track.Source.ScreenShareAudio,
    forceStereo: true,
    dtx: false,
    red: false,
    audioPreset: audioPresetWithBitrate(
      AudioPresets.musicStereo,
      audioBitrateKbps,
    ),
  }
}

export function screenShareCombinedPublishOptions(
  quality: ScreenShareQualityName,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
  limits?: ScreenShareCaptureLimits,
): TrackPublishOptions {
  const capture = screenShareCaptureOptions(quality, limits)
  return {
    ...capture.publish,
    forceStereo: true,
    dtx: false,
    red: false,
    audioPreset: audioPresetWithBitrate(
      AudioPresets.musicStereo,
      audioBitrateKbps,
    ),
  }
}

export function voiceAudioProcessingConstraints(
  prefs: Pick<
    VoicePreferenceState,
    'echoCancellation' | 'automaticGainControl'
  >,
): AudioCaptureOptions {
  return {
    channelCount: 1,
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: false,
    autoGainControl: prefs.automaticGainControl,
  }
}

export function createVoiceRoomOptions(): RoomOptions {
  const prefs = readVoicePreferences()

  const options: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    audioOutput: {
      deviceId: prefs.preferredAudioOutputDevice,
    },
    videoCaptureDefaults: {
      deviceId: prefs.preferredVideoDevice,
    },
  }

  if (!isWindowsDesktopRuntime()) {
    options.audioCaptureDefaults = {
      ...voiceAudioProcessingConstraints(prefs),
      deviceId: prefs.preferredAudioInputDevice,
    }
  }

  return options
}

type RtpVideoCodec = 'vp8' | 'h264' | 'vp9' | 'av1'

export type ScreenShareCaptureLimits = {
  maxWidth?: number
  maxHeight?: number
  maxPixels?: number
  maxFramerate?: number
  maxBitrate?: number
}

type ScreenShareResolution = {
  width: number
  height: number
  frameRate?: number
}

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

function finitePositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function evenFloor(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2)
}

export function fitScreenShareResolutionToLimits(
  resolution: ScreenShareResolution,
  limits?: ScreenShareCaptureLimits,
): ScreenShareResolution {
  if (!limits) return resolution

  const maxWidth = finitePositiveNumber(limits.maxWidth)
  const maxHeight = finitePositiveNumber(limits.maxHeight)
  const maxPixels = finitePositiveNumber(limits.maxPixels)

  let width = resolution.width
  let height = resolution.height

  if (maxWidth != null && width > maxWidth) {
    const scale = maxWidth / width
    width *= scale
    height *= scale
  }

  if (maxHeight != null && height > maxHeight) {
    const scale = maxHeight / height
    width *= scale
    height *= scale
  }

  if (maxPixels != null && width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width *= scale
    height *= scale
  }

  const frameRateLimit = finitePositiveNumber(limits.maxFramerate)
  const frameRate =
    resolution.frameRate != null && frameRateLimit != null
      ? Math.min(resolution.frameRate, frameRateLimit)
      : resolution.frameRate

  return {
    width: evenFloor(width),
    height: evenFloor(height),
    frameRate,
  }
}

function fitScreenShareBitrateToLimits(
  maxBitrate: number,
  limits?: ScreenShareCaptureLimits,
) {
  const limit = finitePositiveNumber(limits?.maxBitrate)
  return limit == null ? maxBitrate : Math.min(maxBitrate, limit)
}

export function screenShareCaptureOptions(
  quality: ScreenShareQualityName,
  limits?: ScreenShareCaptureLimits,
) {
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
          resolution: fitScreenShareResolutionToLimits(
            ScreenSharePresets.h1080fps30.resolution,
            limits,
          ),
          audio: screenShareAudioCaptureOptions(prefs.screenShareAudio),
          contentHint: 'motion' as const,
        },
        publish: publish({
          maxBitrate: fitScreenShareBitrateToLimits(8_000_000, limits),
          maxFramerate: 30,
          priority: 'high',
        }),
      }
    case 'high60':
      return {
        capture: {
          resolution: fitScreenShareResolutionToLimits(
            {
              ...ScreenSharePresets.h1080fps30.resolution,
              frameRate: 60,
            },
            limits,
          ),
          audio: screenShareAudioCaptureOptions(prefs.screenShareAudio),
          contentHint: 'motion' as const,
        },
        publish: publish({
          maxBitrate: fitScreenShareBitrateToLimits(8_000_000, limits),
          maxFramerate: 60,
          priority: 'high',
        }),
      }
    case 'text':
      return {
        capture: {
          resolution: fitScreenShareResolutionToLimits(
            {
              ...ScreenSharePresets.h1080fps30.resolution,
              frameRate: 5,
            },
            limits,
          ),
          audio: screenShareAudioCaptureOptions(prefs.screenShareAudio),
          contentHint: 'text' as const,
        },
        publish: publish({
          maxBitrate: fitScreenShareBitrateToLimits(8_000_000, limits),
          maxFramerate: 5,
          priority: 'high',
        }),
      }
    case 'low':
    default:
      return {
        capture: {
          resolution: fitScreenShareResolutionToLimits(
            ScreenSharePresets.h720fps30.resolution,
            limits,
          ),
          audio: screenShareAudioCaptureOptions(prefs.screenShareAudio),
          contentHint: 'motion' as const,
        },
        publish: publish({
          maxBitrate: fitScreenShareBitrateToLimits(2_500_000, limits),
          maxFramerate: 30,
          priority: 'high',
        }),
      }
  }
}
