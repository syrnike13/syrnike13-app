import { VideoTrack } from '@livekit/react-native'

import type { TrackReference } from '../voice/livekit'

export type VideoViewProps = {
  trackRef: TrackReference
  objectFit: 'contain' | 'cover'
  mirror: boolean
  /** 0 for the main surface, 1 for views floating above another video. */
  zOrder?: number
}

/** A participant's video on Android: LiveKit's native RTCView. */
export function VideoView({ trackRef, objectFit, mirror, zOrder }: VideoViewProps) {
  return <VideoTrack trackRef={trackRef} style={{ flex: 1 }} objectFit={objectFit} mirror={mirror} zOrder={zOrder} />
}
