import { Track, type VideoTrack } from 'livekit-client'

export function stageVideoTrackKey(
  userId: string,
  source: Track.Source.Camera | Track.Source.ScreenShare,
) {
  return `${userId}:${source}`
}

export function pickStageVideoTrack(
  tracks: ReadonlyMap<string, VideoTrack>,
  userId: string,
): VideoTrack | null {
  return (
    tracks.get(stageVideoTrackKey(userId, Track.Source.ScreenShare)) ??
    tracks.get(stageVideoTrackKey(userId, Track.Source.Camera)) ??
    null
  )
}

export function isStageVideoSource(
  source: Track.Source,
): source is Track.Source.Camera | Track.Source.ScreenShare {
  return (
    source === Track.Source.Camera || source === Track.Source.ScreenShare
  )
}
