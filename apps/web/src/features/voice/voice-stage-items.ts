import { Track, type VideoTrack } from 'livekit-client'

import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'
import type {
  NativeVideoRegistryPublication,
  NativeVideoRegistryTrack,
} from '#/features/voice/native-video-registry'
import type {
  VoiceStageMediaItem,
  VoiceStageMediaPublication,
} from '#/features/voice/voice-context'
import {
  buildStageMediaItems,
  stageMediaItemId,
  type StageMediaFilters,
  type StageMediaTrackEntry,
} from '#/features/voice/voice-stage-media'
import { shouldSubscribeStageScreen } from '#/features/voice/voice-stage-subscription'

type StageRoomPublication = VoiceStageMediaPublication & {
  videoTrack?: VideoTrack | null
  subscriptionError?: unknown
}

type StageRoomParticipant = {
  identity: string
  trackPublications: ReadonlyMap<string, StageRoomPublication>
}

export type StageRoom = {
  localParticipant: StageRoomParticipant
  remoteParticipants: ReadonlyMap<string, StageRoomParticipant>
}

export function buildStageItems(options: {
  room: StageRoom | null
  participants: readonly { id: string }[]
  currentUserId: string | null
  filters: StageMediaFilters
  watchedRemoteScreenIds: ReadonlySet<string>
  nativeTracks: readonly NativeVideoRegistryTrack[]
  nativePublications: readonly NativeVideoRegistryPublication[]
  localScreenPreview: {
    userId: string
    track: NativeVideoRegistryTrack['track']
  } | null
  setNativeDemand: (
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) => unknown
}): VoiceStageMediaItem[] {
  const participantIds = new Set(options.participants.map(({ id }) => id))
  const tracks: StageMediaTrackEntry<VideoTrack, VoiceStageMediaPublication>[] = []

  if (options.localScreenPreview) {
    participantIds.add(options.localScreenPreview.userId)
    tracks.push({
      userId: options.localScreenPreview.userId,
      source: 'screen',
      track: options.localScreenPreview.track as unknown as VideoTrack,
      publication: {
        source: Track.Source.ScreenShare,
        isMuted: false,
        isSubscribed: true,
      },
      subscribed: true,
      live: true,
    })
  }

  for (const native of options.nativeTracks) {
    if (native.source === 'screen') continue
    const userId = baseVoiceIdentity(native.participantIdentity)
    if (!participantIds.has(userId)) continue
    tracks.push({
      userId,
      source: 'camera',
      track: native.track as unknown as VideoTrack,
      publication: {
        source: Track.Source.Camera,
        isMuted: false,
        isSubscribed: true,
      },
      subscribed: true,
      live: true,
    })
  }

  for (const publication of options.nativePublications) {
    const userId = baseVoiceIdentity(publication.participantIdentity)
    if (!participantIds.has(userId)) continue
    const mediaId = stageMediaItemId(userId, 'screen')
    const demanded = shouldSubscribeStageScreen({
      isLocal: false,
      mediaId,
      watchedRemoteScreenIds: options.watchedRemoteScreenIds,
    })
    tracks.push({
      userId,
      source: 'screen',
      track:
        demanded && !publication.error
          ? (publication.track as unknown as VideoTrack)
          : null,
      publication: {
        source: Track.Source.ScreenShare,
        isMuted: false,
        isSubscribed: demanded,
        setSubscribed: (nextDemanded) => {
          void options.setNativeDemand(
            publication.sessionId,
            publication.generation,
            publication.demandTrackId,
            nextDemanded,
          )
        },
      },
      subscribed: demanded,
      live: true,
      error: publication.error,
    })
  }

  if (options.room) {
    participantIds.add(baseVoiceIdentity(options.room.localParticipant.identity))
    const roomParticipants = [
      options.room.localParticipant,
      ...options.room.remoteParticipants.values(),
    ]
    for (const participant of roomParticipants) {
      const userId = baseVoiceIdentity(participant.identity)
      const isLocal = participant === options.room.localParticipant
      if (!isLocal && !participantIds.has(userId)) continue
      if (isLocal) participantIds.add(userId)
      for (const publication of participant.trackPublications.values()) {
        const source =
          publication.source === Track.Source.ScreenShare
            ? 'screen'
            : publication.source === Track.Source.Camera
              ? 'camera'
              : null
        if (!source) continue
        const subscribed =
          source === 'screen'
            ? shouldSubscribeStageScreen({
                isLocal,
                mediaId: stageMediaItemId(userId, 'screen'),
                watchedRemoteScreenIds: options.watchedRemoteScreenIds,
              })
            : publication.isSubscribed
        tracks.push({
          userId,
          source,
          track: subscribed ? publication.videoTrack ?? null : null,
          publication,
          subscribed,
          live: !publication.isMuted,
          error:
            source === 'screen' && subscribed
              ? browserScreenSubscriptionError(publication)
              : undefined,
        })
      }
    }
  }

  return buildStageMediaItems({
    participants: [...participantIds].map((id) => ({ id })),
    currentUserId: options.currentUserId,
    tracks,
    filters: options.filters,
  })
}

function browserScreenSubscriptionError(publication: StageRoomPublication) {
  const error = publication.subscriptionError
  if (error == null) return undefined
  const detail = error instanceof Error ? error.message : String(error)
  return detail
    ? `Не удалось подключиться к демонстрации: ${detail}`
    : 'Не удалось подключиться к демонстрации'
}
