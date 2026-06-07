import type { CSSProperties } from 'react'
import type { VideoTrack } from 'livekit-client'

import { VoiceStageEngineVideo } from '#/components/voice/voice-stage-engine-video'
import { VoiceStageVideo } from '#/components/voice/voice-stage-video'
import {
  type EngineStageVideoTrack,
  isEngineStageVideoTrack,
} from '#/features/voice/engine-stage-video'

export function VoiceStageMediaVideo({
  track,
  mediaId,
  className,
  fit = 'cover',
  style,
  onVideoSizeChange,
}: {
  track: VideoTrack | EngineStageVideoTrack
  mediaId: string
  className?: string
  fit?: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
}) {
  if (isEngineStageVideoTrack(track)) {
    return (
      <VoiceStageEngineVideo
        mediaId={mediaId}
        track={track}
        className={className}
        fit={fit}
        style={style}
        onVideoSizeChange={onVideoSizeChange}
      />
    )
  }

  return (
    <VoiceStageVideo
      mediaId={mediaId}
      track={track as VideoTrack}
      className={className}
      fit={fit}
      style={style}
      onVideoSizeChange={onVideoSizeChange}
    />
  )
}
