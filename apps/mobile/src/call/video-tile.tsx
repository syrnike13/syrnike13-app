import { useIsSpeaking, useTracks, VideoTrack, type TrackReference } from '@livekit/react-native'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { LocalVideoTrack, Track } from 'livekit-client'
import { View } from 'react-native'

/**
 * Live cameras and screen shares. A turned-off camera stays published as a
 * muted track and would freeze on its last frame; your own screen would only
 * mirror this app.
 */
export function useCallTracks() {
  return useTracks([Track.Source.ScreenShare, Track.Source.Camera], {
    onlySubscribed: true,
  }).filter(
    (ref) =>
      !ref.publication.isMuted &&
      !(ref.participant.isLocal && ref.source === Track.Source.ScreenShare),
  )
}

/** The track a single-tile view (mini window, system PiP) shows: others' screens, then cameras. */
export function pickFocusTrack(tracks: TrackReference[]) {
  const rank = (ref: TrackReference) =>
    (ref.participant.isLocal ? 2 : 0) + (ref.source === Track.Source.ScreenShare ? 0 : 1)
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0]
}

/** Video aspect as `[width, height]`, falling back to a landscape frame until dimensions arrive. */
export function trackAspect(ref: TrackReference | undefined): [number, number] {
  const dimensions = ref?.publication.dimensions
  if (!dimensions) return [16, 9]
  const { width, height } = dimensions
  // The phone camera reports its sensor's landscape format, but this app is
  // portrait-only, so its own camera frames are always upright portrait.
  if (ref.participant.isLocal && ref.source === Track.Source.Camera) {
    return [Math.min(width, height), Math.max(width, height)]
  }
  return [width, height]
}

/** Tile size that keeps the video's own aspect: full width, but at most `maxHeight` tall. */
export function fitTile(ref: TrackReference, maxWidth: number, maxHeight: number) {
  const [width, height] = trackAspect(ref)
  const fitted = Math.min(maxWidth, (maxHeight * width) / height)
  return { width: fitted, height: (fitted * height) / width }
}

function isMirrored(ref: TrackReference) {
  const track = ref.publication.track
  return track instanceof LocalVideoTrack && track.constraints.facingMode !== 'environment'
}

export function VideoTile({
  trackRef,
  className,
  style,
  zOrder,
  showLabel = true,
}: {
  trackRef: TrackReference
  className?: string
  style?: { width: number; height: number }
  /** 0 for the main surface, 1 for views floating above another video. */
  zOrder?: number
  showLabel?: boolean
}) {
  const speaking = useIsSpeaking(trackRef.participant)
  const screen = trackRef.source === Track.Source.ScreenShare

  return (
    <View
      className={cn(
        'overflow-hidden rounded-xl border-2 bg-card',
        speaking && !screen ? 'border-success' : 'border-transparent',
        className,
      )}
      style={style}
    >
      <VideoTrack
        trackRef={trackRef}
        style={{ flex: 1 }}
        objectFit="contain"
        mirror={isMirrored(trackRef)}
        zOrder={zOrder}
      />
      {showLabel ? (
        <View className="absolute bottom-2 left-2 rounded-md bg-background/70 px-2 py-0.5">
          <Text className="text-xs">{trackRef.participant.name}</Text>
        </View>
      ) : null}
    </View>
  )
}
