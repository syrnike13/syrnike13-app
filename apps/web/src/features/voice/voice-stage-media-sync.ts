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
import {
  detectMissingNativeScreenPublicationLoss,
  hasCurrentNativeScreenPublication,
  type NativeScreenPublicationLoss,
} from '#/features/voice/native-screen-publication-loss'
import type { VoiceDebugAgentPayload } from '#/features/voice/voice-debug-agent-log'
import {
  shouldLogStageSyncScreenStateDebug,
  stageSyncScreenStateDebugKey,
  stageSyncScreenStateDebugPayload,
  type StageSyncScreenStateDebug,
} from '#/features/voice/voice-stage-sync-debug'
import type {
  VoiceStageMediaItem,
  VoiceStageMediaPublication,
} from '#/features/voice/voice-context'

export type ApplyRemoteScreenParticipantSubscriptionOptions = {
  subscribed?: boolean
  currentUserId: string | null
  localParticipantIdentity: string | null
  watchedRemoteScreenIds: ReadonlySet<string>
  pendingScreenWatchIds: ReadonlySet<string>
}

export type SyncRoomParticipantsOptions = {
  room: Room
  nativeMediaState: NativeMediaState
  activeChannelId: string | null
  userId: string | null
  setCameraEnabled: (enabled: boolean) => void
  setScreenShareEnabled: (enabled: boolean) => void
  patchLocalVoiceCamera: (
    channelId: string,
    userId: string,
    enabled: boolean,
  ) => void
  syncStageMediaItems: (room: Room) => void
}

export type SyncStageMediaItemsOptions = {
  room: Room
  nativeMediaState: NativeMediaState
  stoppedNativeScreenIdentity: string | null
  authUserId: string | null
  stageMediaFilters: StageMediaFilters
  watchedRemoteScreenIds: Set<string>
  pendingScreenWatchIds: Set<string>
  lastStageSyncDebugKey: { current: string | null }
  applyRemoteScreenParticipantSubscription: (
    participant: RemoteParticipant,
  ) => void
  setStageMediaItems: (items: VoiceStageMediaItem[]) => void
  onNativeScreenPublicationLost: (loss: NativeScreenPublicationLoss) => void
  logStageSyncDebug: (event: VoiceDebugAgentPayload) => void
}

export function stageMediaTrackSource(
  source: Track.Source,
): StageMediaTrackSource | null {
  if (source === Track.Source.ScreenShare) return 'screen'
  if (source === Track.Source.Camera) return 'camera'
  return null
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

  const { participants, tracks, liveKitIdentity } = collectStageMediaTracks({
    room,
    stoppedNativeScreenIdentity,
    authUserId,
    watchedRemoteScreenIds,
    pendingScreenWatchIds,
    applyRemoteScreenParticipantSubscription:
      options.applyRemoteScreenParticipantSubscription,
  })
  const items = buildSyncedStageMediaItems({
    participants,
    authUserId,
    liveKitIdentity,
    tracks,
    filters: stageMediaFilters,
  })
  const nativeScreenStats = collectNativeScreenStats(room, nativeMediaState)

  logStageSyncScreenState(options, {
    ...nativeScreenStats,
    tracks: tracks.length,
    items,
  })
  reportMissingNativeScreenPublication(options, nativeScreenStats)
  syncStageScreenWatchState({
    room,
    items,
    watchedRemoteScreenIds,
    pendingScreenWatchIds,
  })

  options.setStageMediaItems(items)
}

type StageMediaCollectionOptions = Pick<
  SyncStageMediaItemsOptions,
  | 'room'
  | 'stoppedNativeScreenIdentity'
  | 'authUserId'
  | 'watchedRemoteScreenIds'
  | 'pendingScreenWatchIds'
  | 'applyRemoteScreenParticipantSubscription'
>

type StageMediaCollection = {
  participants: { id: string }[]
  tracks: StageMediaTrackEntry<VideoTrack, VoiceStageMediaPublication>[]
  liveKitIdentity: string
}

function collectStageMediaTracks(
  options: StageMediaCollectionOptions,
): StageMediaCollection {
  const {
    room,
    stoppedNativeScreenIdentity,
    authUserId,
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
    const entry = stageMediaTrackEntryForPublication({
      userId,
      publication,
      isLocalPublication,
      currentUserIds,
      watchedRemoteScreenIds,
      pendingScreenWatchIds,
    })
    if (entry) tracks.push(entry)
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

  return { participants, tracks, liveKitIdentity }
}

function stageMediaTrackEntryForPublication({
  userId,
  publication,
  isLocalPublication,
  currentUserIds,
  watchedRemoteScreenIds,
  pendingScreenWatchIds,
}: {
  userId: string
  publication: VoiceStageMediaPublication | null | undefined
  isLocalPublication: boolean
  currentUserIds: ReadonlySet<string>
  watchedRemoteScreenIds: ReadonlySet<string>
  pendingScreenWatchIds: ReadonlySet<string>
}): StageMediaTrackEntry<VideoTrack, VoiceStageMediaPublication> | null {
  if (!publication) return null
  const source = stageMediaTrackSource(publication.source)
  if (!source) return null
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
  if (source === 'camera' && (!track || !subscribed)) return null
  return {
    userId: normalizedUserId,
    source,
    track,
    publication,
    subscribed,
    live: publication.isMuted !== true,
  }
}

function buildSyncedStageMediaItems({
  participants,
  authUserId,
  liveKitIdentity,
  tracks,
  filters,
}: {
  participants: { id: string }[]
  authUserId: string | null
  liveKitIdentity: string
  tracks: StageMediaTrackEntry<VideoTrack, VoiceStageMediaPublication>[]
  filters: StageMediaFilters
}) {
  return buildStageMediaItems({
    participants,
    currentUserId: authUserId ?? baseVoiceIdentity(liveKitIdentity),
    tracks,
    filters,
  }).map((item) => ({
    ...item,
    isLocal: isVoiceLocalUserId(item.userId, authUserId, liveKitIdentity),
  }))
}

type NativeScreenStats = {
  nativeScreenParticipants: RemoteParticipant[]
  nativeScreenPublications: number
  nativeScreenPublicationPresent: boolean | null
}

function collectNativeScreenStats(
  room: Room,
  nativeMediaState: NativeMediaState,
): NativeScreenStats {
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
  const nativeScreenPublicationPresent =
    nativeMediaState.screen.status === 'published'
      ? hasCurrentNativeScreenPublication(room, nativeMediaState.screen)
      : null

  return {
    nativeScreenParticipants,
    nativeScreenPublications,
    nativeScreenPublicationPresent,
  }
}

function logStageSyncScreenState(
  options: SyncStageMediaItemsOptions,
  input: NativeScreenStats & {
    tracks: number
    items: VoiceStageMediaItem[]
  },
) {
  const screenItems = input.items.filter((item) => item.kind === 'screen')
  const localScreenItems = screenItems.filter((item) => item.isLocal)
  const state: StageSyncScreenStateDebug = {
    nativeScreenState: options.nativeMediaState.screen.status,
    nativeScreenVisible: options.nativeMediaState.screen.visibleInRoom,
    remoteParticipants: options.room.remoteParticipants.size,
    nativeScreenParticipants: input.nativeScreenParticipants.length,
    nativeScreenPublications: input.nativeScreenPublications,
    nativeScreenPublicationPresent: input.nativeScreenPublicationPresent,
    tracks: input.tracks,
    screenItems: screenItems.length,
    localScreenItems: localScreenItems.length,
    localScreenLive: localScreenItems.some((item) => item.live),
  }
  const stageDebugKey = stageSyncScreenStateDebugKey(state)
  if (
    options.lastStageSyncDebugKey.current === stageDebugKey ||
    !shouldLogStageSyncScreenStateDebug(state)
  ) {
    return
  }

  options.lastStageSyncDebugKey.current = stageDebugKey
  options.logStageSyncDebug(stageSyncScreenStateDebugPayload(state))
}

function reportMissingNativeScreenPublication(
  options: SyncStageMediaItemsOptions,
  stats: NativeScreenStats,
) {
  const loss = detectMissingNativeScreenPublicationLoss({
    room: options.room,
    screen: options.nativeMediaState.screen,
    stoppedNativeScreenIdentity: options.stoppedNativeScreenIdentity,
    remoteParticipants: options.room.remoteParticipants.size,
    nativeScreenPublicationPresent: stats.nativeScreenPublicationPresent,
  })
  if (loss) options.onNativeScreenPublicationLost(loss)
}

function syncStageScreenWatchState({
  room,
  items,
  watchedRemoteScreenIds,
  pendingScreenWatchIds,
}: {
  room: Room
  items: VoiceStageMediaItem[]
  watchedRemoteScreenIds: Set<string>
  pendingScreenWatchIds: Set<string>
}) {
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
}
