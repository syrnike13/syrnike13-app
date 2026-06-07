import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react'

import { VOICE_STAGE_MEDIA_ID_ATTR } from '#/components/voice/voice-stage-video'
import type { EngineStageVideoTrack } from '#/features/voice/engine-stage-video'
import {
  getMediaEngineRemoteVideoFrame,
  subscribeMediaEngineRemoteVideo,
} from '#/features/voice/media-engine-remote-video'
import { cn } from '#/lib/utils'

export function VoiceStageEngineVideo({
  track,
  mediaId,
  className,
  fit = 'cover',
  style,
  onVideoSizeChange,
}: {
  track: EngineStageVideoTrack
  mediaId: string
  className?: string
  fit?: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onVideoSizeChangeRef = useRef(onVideoSizeChange)
  onVideoSizeChangeRef.current = onVideoSizeChange

  const frame = useSyncExternalStore(
    subscribeMediaEngineRemoteVideo,
    () => getMediaEngineRemoteVideoFrame(track.userId, track.source),
    () => null,
  )

  useEffect(() => {
    if (!frame || frame.width <= 0 || frame.height <= 0) return
    onVideoSizeChangeRef.current?.({
      width: frame.width,
      height: frame.height,
    })
  }, [frame?.height, frame?.jpegDataUrl, frame?.width])

  return (
    <div ref={hostRef} className="absolute inset-0 size-full">
      {frame ? (
        <img
          alt=""
          src={frame.jpegDataUrl}
          data-voice-stage-media-id={mediaId}
          className={cn(
            'absolute inset-0 size-full',
            fit === 'contain' ? 'object-contain' : 'object-cover',
            className,
          )}
          style={style}
          draggable={false}
        />
      ) : null}
    </div>
  )
}
