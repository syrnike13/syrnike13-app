import { Track } from 'livekit-client'

import type { StageMediaItem } from '#/features/voice/voice-stage-media'

type StageScreenPublication = {
  source?: Track.Source
  isSubscribed?: boolean
  setSubscribed?: (subscribed: boolean) => void
}

export type StageMediaSubscriptionAction = 'none' | 'stop-local-screen'

export function shouldSubscribeStageScreen({
  isLocal,
  mediaId,
  currentUserIds,
  watchedRemoteScreenIds,
  pendingScreenWatchIds,
}: {
  isLocal: boolean
  mediaId: string
  currentUserIds?: ReadonlySet<string>
  watchedRemoteScreenIds: ReadonlySet<string>
  pendingScreenWatchIds?: ReadonlySet<string>
}) {
  const userId = stageScreenMediaUserId(mediaId)
  return (
    isLocal ||
    Boolean(userId && currentUserIds?.has(userId)) ||
    watchedRemoteScreenIds.has(mediaId) ||
    Boolean(pendingScreenWatchIds?.has(mediaId))
  )
}

export function applyStageScreenPublicationSubscription(
  publication: StageScreenPublication | null | undefined,
  subscribed: boolean,
) {
  if (!publication) return
  if (
    publication.source !== Track.Source.ScreenShare &&
    publication.source !== Track.Source.ScreenShareAudio
  ) {
    return
  }
  if (publication.isSubscribed === subscribed) return
  publication.setSubscribed?.(subscribed)
}

export function stageScreenMediaUserId(mediaId: string) {
  const suffix = ':screen'
  return mediaId.endsWith(suffix) ? mediaId.slice(0, -suffix.length) : null
}

export function setRemoteScreenWatchIntent(
  watchedRemoteScreenIds: Set<string>,
  pendingScreenWatchIds: Set<string>,
  mediaId: string,
  subscribed: boolean,
) {
  if (subscribed) {
    pendingScreenWatchIds.add(mediaId)
    watchedRemoteScreenIds.add(mediaId)
    return
  }

  pendingScreenWatchIds.delete(mediaId)
  watchedRemoteScreenIds.delete(mediaId)
}

export function resolveStageScreenSubscriptionTarget(
  item: StageMediaItem<unknown, unknown> | null | undefined,
  mediaId: string,
  currentUserIds: ReadonlySet<string>,
) {
  if (item && item.kind === 'screen') {
    return {
      mediaId: item.id,
      userId: item.userId,
      isLocal: item.isLocal,
    }
  }

  const userId = stageScreenMediaUserId(mediaId)
  return {
    mediaId,
    userId,
    isLocal: Boolean(userId && currentUserIds.has(userId)),
  }
}

export function pruneWatchedRemoteScreenIds(
  watchedRemoteScreenIds: Set<string>,
  pendingScreenWatchIds: Set<string>,
  visibleRemoteScreenIds: ReadonlySet<string>,
  remoteParticipantUserIds: ReadonlySet<string>,
) {
  const mediaIds = new Set([
    ...watchedRemoteScreenIds,
    ...pendingScreenWatchIds,
  ])
  for (const mediaId of mediaIds) {
    if (visibleRemoteScreenIds.has(mediaId)) continue

    const userId = stageScreenMediaUserId(mediaId)
    if (userId && remoteParticipantUserIds.has(userId)) continue

    watchedRemoteScreenIds.delete(mediaId)
    pendingScreenWatchIds.delete(mediaId)
  }
}

export function setStageScreenSubscription(
  item: StageMediaItem<unknown, StageScreenPublication> | null | undefined,
  subscribed: boolean,
): StageMediaSubscriptionAction {
  if (!item || item.kind !== 'screen') return 'none'

  if (item.isLocal) {
    return subscribed ? 'none' : 'stop-local-screen'
  }

  item.publication?.setSubscribed?.(subscribed)
  return 'none'
}
