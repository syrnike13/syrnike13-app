import type { VideoTrack } from 'livekit-client'

import type { NativeVideoTrackAdapter } from '#/features/voice/native-video-registry'
import type {
  StageMediaItem,
  StageMediaTrackSource,
} from '#/features/voice/voice-stage-media'

export type VoiceStageMediaTrack =
  | {
      backend: 'livekit'
      track: VideoTrack
    }
  | {
      backend: 'native'
      track: NativeVideoTrackAdapter
    }

export type VoiceStageMediaPublicationOptions = {
  videoCodec?: string
  simulcast?: boolean
  degradationPreference?: string
  screenShareEncoding?: {
    maxBitrate?: number
    maxFramerate?: number
  }
  videoEncoding?: {
    maxBitrate?: number
    maxFramerate?: number
  }
}

export type VoiceStageMediaPublication = {
  backend: 'livekit' | 'native'
  source: StageMediaTrackSource
  trackSid?: string
  isMuted: boolean
  isSubscribed: boolean
  setSubscribed?: (subscribed: boolean) => void
  options?: VoiceStageMediaPublicationOptions
}

export type VoiceStageMediaItem = StageMediaItem<
  VoiceStageMediaTrack,
  VoiceStageMediaPublication
>

export function liveKitVoiceStageMediaTrack(
  track: VideoTrack,
): VoiceStageMediaTrack {
  return { backend: 'livekit', track }
}

export function nativeVoiceStageMediaTrack(
  track: NativeVideoTrackAdapter,
): VoiceStageMediaTrack {
  return { backend: 'native', track }
}

export function voiceStageMediaStreamTrack(
  track: VoiceStageMediaTrack | null | undefined,
) {
  return track?.backend === 'livekit'
    ? track.track.mediaStreamTrack
    : undefined
}

export function setVoiceStageMediaPublicationSubscribed(
  publication: VoiceStageMediaPublication | null | undefined,
  subscribed: boolean,
) {
  if (!publication || publication.isSubscribed === subscribed) return
  publication.setSubscribed?.(subscribed)
}
