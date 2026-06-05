import { useEffect, useRef, type CSSProperties } from 'react'
import type { VideoTrack } from 'livekit-client'

import { cn } from '#/lib/utils'

export function VoiceStageVideo({
  track,
  className,
  fit = 'cover',
  style,
  onVideoSizeChange,
}: {
  track: VideoTrack
  className?: string
  fit?: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const emitSize = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) {
        onVideoSizeChange?.({
          width: element.videoWidth,
          height: element.videoHeight,
        })
      }
    }
    const attached = track.attach(element)
    emitSize()
    element.addEventListener('loadedmetadata', emitSize)
    element.addEventListener('resize', emitSize)
    void element.play().catch(() => {})
    return () => {
      element.removeEventListener('loadedmetadata', emitSize)
      element.removeEventListener('resize', emitSize)
      track.detach(attached)
    }
  }, [onVideoSizeChange, track])

  return (
    <video
      ref={videoRef}
      className={cn(
        'absolute inset-0 size-full',
        fit === 'contain' ? 'object-contain' : 'object-cover',
        className,
      )}
      style={style}
      playsInline
      autoPlay
      muted
    />
  )
}
