import {
  Track,
  type LocalTrackPublication,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client'

import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'
import type {
  NativeVideoRegistryPublication,
  NativeVideoRegistryTrack,
} from '#/features/voice/native-video-registry'
import {
  liveKitVoiceStageMediaTrack,
  nativeVoiceStageMediaTrack,
  type VoiceStageMediaTrack,
  type VoiceStageMediaItem,
  type VoiceStageMediaPublication,
} from '#/features/voice/voice-context'
import {
  buildStageMediaItems,
  stageMediaItemId,
  type StageMediaFilters,
  type StageMediaTrackEntry,
} from '#/features/voice/voice-stage-media'
import { shouldSubscribeStageScreen } from '#/features/voice/voice-stage-subscription'

type StageRoomTrack = Omit<
  StageMediaTrackEntry<VoiceStageMediaTrack, VoiceStageMediaPublication>,
  'userId'
>

type StageRoomParticipant = {
  identity: string
  tracks: readonly StageRoomTrack[]
}

export type StageRoom = {
  localParticipant: StageRoomParticipant
  remoteParticipants: readonly StageRoomParticipant[]
}

export function createStageRoomFromLiveKit(
  room: Room,
  subscriptionErrors: ReadonlyMap<string, string>,
): StageRoom {
  return {
    localParticipant: {
      identity: room.localParticipant.identity,
      tracks: [...room.localParticipant.trackPublications.values()]
        .map(localStageRoomTrack)
        .filter((track) => track !== null),
    },
    remoteParticipants: [...room.remoteParticipants.values()].map(
      (participant) => ({
        identity: participant.identity,
        tracks: [...participant.trackPublications.values()]
          .map((publication) =>
            remoteStageRoomTrack(publication, subscriptionErrors),
          )
          .filter((track) => track !== null),
      }),
    ),
  }
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
  const tracks: StageMediaTrackEntry<
    VoiceStageMediaTrack,
    VoiceStageMediaPublication
  >[] = []
  const nativePublicationIds = new Set(
    options.nativePublications.map(({ trackId }) => trackId),
  )

  if (options.localScreenPreview) {
    participantIds.add(options.localScreenPreview.userId)
    tracks.push({
      userId: options.localScreenPreview.userId,
      source: 'screen',
      track: nativeVoiceStageMediaTrack(options.localScreenPreview.track),
      publication: {
        backend: 'native',
        source: 'screen',
        isMuted: false,
        isSubscribed: true,
      },
      subscribed: true,
      live: true,
    })
  }

  for (const native of options.nativeTracks) {
    if (native.source === 'screen' || nativePublicationIds.has(native.trackId)) continue
    const userId = baseVoiceIdentity(native.participantIdentity)
    if (!participantIds.has(userId)) continue
    tracks.push({
      userId,
      source: 'camera',
      track: nativeVoiceStageMediaTrack(native.track),
      publication: {
        backend: 'native',
        source: 'camera',
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
    const source = publication.source
    const mediaId = stageMediaItemId(userId, source)
    const demanded = source === 'screen'
      ? shouldSubscribeStageScreen({
          isLocal: false,
          mediaId,
          watchedRemoteScreenIds: options.watchedRemoteScreenIds,
        })
      : options.filters.showRemoteStreams
    tracks.push({
      userId,
      source,
      track: demanded
        ? publication.track
          ? nativeVoiceStageMediaTrack(publication.track)
          : null
        : null,
      publication: {
        backend: 'native',
        source,
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
      error: demanded ? publication.error ?? undefined : undefined,
    })
  }

  if (options.room) {
    participantIds.add(baseVoiceIdentity(options.room.localParticipant.identity))
    const roomParticipants = [
      options.room.localParticipant,
      ...options.room.remoteParticipants,
    ]
    for (const participant of roomParticipants) {
      const userId = baseVoiceIdentity(participant.identity)
      const isLocal = participant === options.room.localParticipant
      if (!isLocal && !participantIds.has(userId)) continue
      if (isLocal) participantIds.add(userId)
      for (const roomTrack of participant.tracks) {
        const source = roomTrack.source
        const subscribed =
          source === 'screen'
            ? shouldSubscribeStageScreen({
                isLocal,
                mediaId: stageMediaItemId(userId, 'screen'),
                watchedRemoteScreenIds: options.watchedRemoteScreenIds,
              })
            : roomTrack.subscribed
        tracks.push({
          userId,
          source,
          track: subscribed ? roomTrack.track ?? null : null,
          publication: roomTrack.publication,
          subscribed,
          live: roomTrack.live,
          error:
            source === 'screen' && subscribed
              ? roomTrack.error
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

function localStageRoomTrack(
  publication: LocalTrackPublication,
): StageRoomTrack | null {
  const source = stageTrackSource(publication.source)
  if (!source) return null
  return {
    source,
    track: publication.videoTrack
      ? liveKitVoiceStageMediaTrack(publication.videoTrack)
      : null,
    publication: {
      backend: 'livekit',
      source,
      trackSid: publication.trackSid,
      isMuted: publication.isMuted,
      isSubscribed: publication.isSubscribed,
      options: liveKitPublicationOptions(publication),
    },
    subscribed: publication.isSubscribed,
    live: !publication.isMuted,
  }
}

function remoteStageRoomTrack(
  publication: RemoteTrackPublication,
  subscriptionErrors: ReadonlyMap<string, string>,
): StageRoomTrack | null {
  const source = stageTrackSource(publication.source)
  if (!source) return null
  return {
    source,
    track: publication.videoTrack
      ? liveKitVoiceStageMediaTrack(publication.videoTrack)
      : null,
    publication: {
      backend: 'livekit',
      source,
      trackSid: publication.trackSid,
      isMuted: publication.isMuted,
      isSubscribed: publication.isSubscribed,
      setSubscribed: (subscribed) => publication.setSubscribed(subscribed),
    },
    subscribed: publication.isSubscribed,
    live: !publication.isMuted,
    error:
      source === 'screen'
        ? browserScreenSubscriptionError(
            publication.trackSid,
            subscriptionErrors,
          )
        : undefined,
  }
}

function stageTrackSource(source: Track.Source) {
  if (source === Track.Source.ScreenShare) return 'screen' as const
  if (source === Track.Source.Camera) return 'camera' as const
  return null
}

function liveKitPublicationOptions(
  publication: LocalTrackPublication,
): VoiceStageMediaPublication['options'] {
  const options = publication.options
  if (!options) return undefined
  return {
    videoCodec: options.videoCodec,
    simulcast: options.simulcast,
    degradationPreference: options.degradationPreference,
    screenShareEncoding: options.screenShareEncoding
      ? {
          maxBitrate: options.screenShareEncoding.maxBitrate,
          maxFramerate: options.screenShareEncoding.maxFramerate,
        }
      : undefined,
    videoEncoding: options.videoEncoding
      ? {
          maxBitrate: options.videoEncoding.maxBitrate,
          maxFramerate: options.videoEncoding.maxFramerate,
        }
      : undefined,
  }
}

function browserScreenSubscriptionError(
  trackSid: string,
  subscriptionErrors: ReadonlyMap<string, string>,
) {
  if (!subscriptionErrors.has(trackSid)) return undefined
  const detail = subscriptionErrors.get(trackSid) ?? ''
  return detail
    ? `Не удалось подключиться к демонстрации: ${detail}`
    : 'Не удалось подключиться к демонстрации'
}
