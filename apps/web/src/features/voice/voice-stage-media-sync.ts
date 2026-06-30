import {
  Track,
  type RemoteParticipant,
  type Room,
  type VideoTrack,
} from 'livekit-client'

import {
  isNativeScreenPublished,
  type NativeMediaState,
} from '#/features/voice/native-media-coordinator'
import { isVoiceLocalUserId } from '#/features/voice/voice-connecting-preview'
import { liveKitRoomParticipantIds } from '#/features/voice/voice-participant-sync'
import { localParticipantVoiceFlags } from '#/features/voice/voice-participant-media'
import {
  buildStageMediaItems,
  stageMediaItemId,
  type StageMediaFilters,
  type StageMediaTrackEntry,
  type StageMediaTrackSource,
} from '#/features/voice/voice-stage-media'
import {
  applyStageScreenPublicationSubscription,
  pruneWatchedRemoteScreenIds,
  shouldSubscribeStageScreen,
} from '#/features/voice/voice-stage-subscription'
import {
  baseVoiceIdentity,
  isDesktopNativeVoiceIdentity,
} from '#/features/voice/native-voice-identity'
import type {
  VoiceStageMediaItem,
  VoiceStageMediaPublication,
} from '#/features/voice/voice-context'

export type ApplyRemoteScreenParticipantSubscriptionOptions = {
  subscribed?: boolean
  currentUserId: string | null | undefined
  localParticipantIdentity: string | null | undefined
  watchedRemoteScreenIds: ReadonlySet<string>
  pendingScreenWatchIds: ReadonlySet<string>
}

export type SyncRoomParticipantsOptions = {
  room: Room
  nativeMediaState: NativeMediaState
  activeChannelId: string | null | undefined
  userId: string | null | undefined
  setCameraEnabled: (enabled: boolean) => void
  setScreenShareEnabled: (enabled: boolean) => void
  patchLocalVoiceCamera: (
    channelId: string,
    userId: string,
    enabled: boolean,
  ) => void
  syncStageMediaItems: (room: Room) => void
}

export type NativeScreenPublicationLossReason =
  | 'participant-disconnected'
  | 'track-unpublished'
  | 'publication-missing'

export type NativeScreenPublicationLoss = {
  reason: NativeScreenPublicationLossReason
  participantIdentity: string
  publicationSid?: string
  remoteParticipants?: number
}

export type SyncStageMediaItemsOptions = {
  room: Room
  nativeMediaState: NativeMediaState
  stoppedNativeScreenIdentity: string | null | undefined
  authUserId: string | null | undefined
  stageMediaFilters: StageMediaFilters
  watchedRemoteScreenIds: Set<string>
  pendingScreenWatchIds: Set<string>
  lastStageSyncDebugKey: { current: string | null }
  applyRemoteScreenParticipantSubscription: (
    participant: RemoteParticipant,
  ) => void
  setStageMediaItems: (items: VoiceStageMediaItem[]) => void
  onNativeScreenPublicationLost: (loss: NativeScreenPublicationLoss) => void
  logStageSyncDebug: (event: {
    hypothesis: 'H3-stage-native-screen-loss'
    event: 'stage-sync-screen-state'
    nativeScreenState: NativeMediaState['screen']['status']
    nativeScreenVisible?: boolean
    remoteParticipants: number
    nativeScreenParticipants: number
    nativeScreenPublications: number
    nativeScreenPublicationPresent: boolean | null
    tracks: number
    screenItems: number
    localScreenItems: number
    localScreenLive: boolean
  }) => void
}

export function stageMediaTrackSource(
  source: Track.Source,
): StageMediaTrackSource | null {
  if (source === Track.Source.ScreenShare) return 'screen'
  if (source === Track.Source.Camera) return 'camera'
  return null
}

export function hasCurrentNativeScreenPublication(
  room: Room,
  screen: NativeMediaState['screen'],
) {
  if (screen.status !== 'published') return false
  const participant = room.remoteParticipants.get(screen.participantIdentity)
  if (!participant) return false

  for (const publication of participant.trackPublications.values()) {
    if (publication.source !== Track.Source.ScreenShare) continue
    if (publication.trackSid === screen.publicationSid) return true
  }

  return false
}

export function applyRemoteScreenParticipantSubscription(
  participant: RemoteParticipant,
  options: ApplyRemoteScreenParticipantSubscriptionOptions,
) {
  const userId = baseVoiceIdentity(participant.identity)
  const currentUserIds = new Set<string>()
  if (options.currentUserId) currentUserIds.add(options.currentUserId)
  if (options.localParticipantIdentity) {
    currentUserIds.add(baseVoiceIdentity(options.localParticipantIdentity))
  }
  const mediaId = stageMediaItemId(userId, 'screen')
  const nextSubscribed =
    options.subscribed ??
    shouldSubscribeStageScreen({
      isLocal: false,
      mediaId,
      currentUserIds,
      watchedRemoteScreenIds: options.watchedRemoteScreenIds,
      pendingScreenWatchIds: options.pendingScreenWatchIds,
    })

  for (const publication of participant.trackPublications.values()) {
    applyStageScreenPublicationSubscription(publication, nextSubscribed)
  }

  return nextSubscribed
}

export function syncRoomParticipants(options: SyncRoomParticipantsOptions) {
  const localMedia = localParticipantVoiceFlags(options.room.localParticipant)
  options.setCameraEnabled(localMedia.camera)
  options.setScreenShareEnabled(
    localMedia.screensharing ||
      isNativeScreenPublished(options.nativeMediaState),
  )
  if (options.activeChannelId && options.userId) {
    options.patchLocalVoiceCamera(
      options.activeChannelId,
      options.userId,
      localMedia.camera,
    )
  }
  options.syncStageMediaItems(options.room)
}

export function syncStageMediaItems(options: SyncStageMediaItemsOptions) {
  const {
    room,
    nativeMediaState,
    stoppedNativeScreenIdentity,
    authUserId,
    stageMediaFilters,
    watchedRemoteScreenIds,
    pendingScreenWatchIds,
  } = options
  const excludedParticipantIdentities = stoppedNativeScreenIdentity
    ? new Set([stoppedNativeScreenIdentity])
    : undefined
  const liveKitIdentity = room.localParticipant.identity
  const currentUserIds = new Set<string>()
  if (authUserId) currentUserIds.add(authUserId)
  currentUserIds.add(baseVoiceIdentity(liveKitIdentity))
  const participants = liveKitRoomParticipantIds(room, {
    excludedParticipantIdentities,
  }).map((id) => ({ id }))
  const tracks: StageMediaTrackEntry<VideoTrack, VoiceStageMediaPublication>[] =
    []
  const ingest = (
    userId: string,
    publication: VoiceStageMediaPublication | null | undefined,
    isLocalPublication: boolean,
  ) => {
    if (!publication) return
    const source = stageMediaTrackSource(publication.source)
    if (!source) return
    const normalizedUserId = baseVoiceIdentity(userId)
    const mediaId = stageMediaItemId(normalizedUserId, source)
    const subscribed =
      source === 'screen'
        ? shouldSubscribeStageScreen({
            isLocal: isLocalPublication,
            mediaId,
            currentUserIds,
            watchedRemoteScreenIds,
            pendingScreenWatchIds,
          })
        : publication.isSubscribed !== false
    if (!isLocalPublication && source === 'screen') {
      applyStageScreenPublicationSubscription(publication, subscribed)
    }
    const track =
      publication.track?.kind === Track.Kind.Video
        ? (publication.track as VideoTrack)
        : null
    if (source === 'camera' && (!track || !subscribed)) return
    tracks.push({
      userId: normalizedUserId,
      source,
      track,
      publication,
      subscribed,
      live: publication.isMuted !== true,
    })
  }

  for (const publication of room.localParticipant.trackPublications.values()) {
    ingest(room.localParticipant.identity, publication, true)
  }

  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity === stoppedNativeScreenIdentity) continue
    options.applyRemoteScreenParticipantSubscription(participant)
    for (const publication of participant.trackPublications.values()) {
      ingest(participant.identity, publication, false)
    }
  }

  const items = buildStageMediaItems({
    participants,
    currentUserId: authUserId ?? baseVoiceIdentity(liveKitIdentity),
    tracks,
    filters: stageMediaFilters,
  }).map((item) => ({
    ...item,
    isLocal: isVoiceLocalUserId(
      item.userId,
      authUserId ?? undefined,
      liveKitIdentity,
    ),
  }))
  const nativeScreenParticipants = Array.from(
    room.remoteParticipants.values(),
  ).filter(
    (participant) =>
      isDesktopNativeVoiceIdentity(participant.identity) &&
      participant.identity.endsWith(':screen'),
  )
  const nativeScreenPublications = nativeScreenParticipants.reduce(
    (count, participant) =>
      count +
      Array.from(participant.trackPublications.values()).filter(
        (publication) => publication.source === Track.Source.ScreenShare,
      ).length,
    0,
  )
  const screenItems = items.filter((item) => item.kind === 'screen')
  const localScreenItems = screenItems.filter((item) => item.isLocal)
  const nativeScreenPublicationPresent =
    nativeMediaState.screen.status === 'published'
      ? hasCurrentNativeScreenPublication(room, nativeMediaState.screen)
      : null
  const stageDebugKey = JSON.stringify({
    nativeScreenState: nativeMediaState.screen.status,
    nativeScreenVisible: nativeMediaState.screen.visibleInRoom,
    remoteParticipants: room.remoteParticipants.size,
    nativeScreenParticipants: nativeScreenParticipants.length,
    nativeScreenPublications,
    nativeScreenPublicationPresent,
    tracks: tracks.length,
    screenItems: screenItems.length,
    localScreenItems: localScreenItems.length,
  })
  if (
    options.lastStageSyncDebugKey.current !== stageDebugKey &&
    (nativeMediaState.screen.status !== 'idle' ||
      nativeScreenParticipants.length > 0 ||
      screenItems.length > 0)
  ) {
    options.lastStageSyncDebugKey.current = stageDebugKey
    options.logStageSyncDebug({
      hypothesis: 'H3-stage-native-screen-loss',
      event: 'stage-sync-screen-state',
      nativeScreenState: nativeMediaState.screen.status,
      nativeScreenVisible: nativeMediaState.screen.visibleInRoom,
      remoteParticipants: room.remoteParticipants.size,
      nativeScreenParticipants: nativeScreenParticipants.length,
      nativeScreenPublications,
      nativeScreenPublicationPresent,
      tracks: tracks.length,
      screenItems: screenItems.length,
      localScreenItems: localScreenItems.length,
      localScreenLive: localScreenItems.some((item) => item.live),
    })
  }
  if (
    nativeMediaState.screen.status === 'published' &&
    nativeScreenPublicationPresent === false &&
    stoppedNativeScreenIdentity !== nativeMediaState.screen.participantIdentity
  ) {
    options.onNativeScreenPublicationLost({
      reason: 'publication-missing',
      participantIdentity: nativeMediaState.screen.participantIdentity,
      publicationSid: nativeMediaState.screen.publicationSid,
      remoteParticipants: room.remoteParticipants.size,
    })
  }

  const visibleRemoteScreenIds = new Set(
    items
      .filter((item) => item.kind === 'screen' && !item.isLocal)
      .map((item) => item.id),
  )
  const remoteParticipantUserIds = new Set(
    Array.from(room.remoteParticipants.values()).map((participant) =>
      baseVoiceIdentity(participant.identity),
    ),
  )
  pruneWatchedRemoteScreenIds(
    watchedRemoteScreenIds,
    pendingScreenWatchIds,
    visibleRemoteScreenIds,
    remoteParticipantUserIds,
  )

  for (const item of items) {
    if (item.kind !== 'screen' || item.isLocal || item.subscribed === false) {
      continue
    }
    pendingScreenWatchIds.delete(item.id)
    watchedRemoteScreenIds.add(item.id)
  }

  options.setStageMediaItems(items)
}
