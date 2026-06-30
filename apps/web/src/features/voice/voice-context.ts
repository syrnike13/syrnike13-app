import type { Track, VideoTrack } from 'livekit-client'

import type {
  StageMediaItem,
} from '#/features/voice/voice-stage-media'

export type VoiceStageMediaPublication = {
  source: Track.Source
  track?: Track | null
  isMuted?: boolean
  isSubscribed?: boolean
  setSubscribed?: (subscribed: boolean) => void
  options?: {
    videoCodec?: string
    simulcast?: boolean
    degradationPreference?: string
    screenShareEncoding?: {
      maxBitrate?: number
      maxFramerate?: number
    }
  }
}

export type VoiceStageMediaItem = StageMediaItem<
  VideoTrack,
  VoiceStageMediaPublication
>
