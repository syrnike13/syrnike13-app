import type { StageMediaTrackSource } from '#/features/voice/voice-stage-media'

export type EngineStageVideoTrack = {
  readonly kind: 'engine-video'
  readonly userId: string
  readonly source: StageMediaTrackSource
}

export function createEngineStageVideoTrack(
  userId: string,
  source: StageMediaTrackSource,
): EngineStageVideoTrack {
  return { kind: 'engine-video', userId, source }
}

export function isEngineStageVideoTrack(
  track: unknown,
): track is EngineStageVideoTrack {
  return (
    typeof track === 'object' &&
    track !== null &&
    (track as EngineStageVideoTrack).kind === 'engine-video'
  )
}

export function engineStageVideoKey(
  userId: string,
  source: StageMediaTrackSource,
) {
  return `${userId}:${source}`
}
