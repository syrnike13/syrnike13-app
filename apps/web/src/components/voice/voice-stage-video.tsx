import { useEffect, useRef } from 'react'
import type { VideoTrack } from 'livekit-client'

import { cn } from '#/lib/utils'

export function VoiceStageVideo({
  track,
  className,
}: {
  track: VideoTrack
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const attached = track.attach(element)
    void element.play().catch(() => {})
    return () => {
      track.detach(attached)
    }
  }, [track])

  return (
    <video
      ref={videoRef}
      className={cn('absolute inset-0 size-full object-cover', className)}
      playsInline
      autoPlay
      muted
    />
  )
}
