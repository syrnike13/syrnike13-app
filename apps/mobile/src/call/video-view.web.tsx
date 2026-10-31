import { VideoTrack } from '@livekit/components-react'

import type { VideoViewProps } from './video-view'

/** A participant's video in the browser: a plain `<video>` attached by LiveKit. */
export function VideoView({ trackRef, objectFit, mirror }: VideoViewProps) {
  return (
    <VideoTrack
      trackRef={trackRef}
      style={{
        width: '100%',
        height: '100%',
        objectFit,
        transform: mirror ? 'scaleX(-1)' : undefined,
      }}
    />
  )
}
