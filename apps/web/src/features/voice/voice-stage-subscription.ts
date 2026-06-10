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
  watchedRemoteScreenIds,
  pendingScreenWatchIds,
}: {
  isLocal: boolean
  mediaId: string
  watchedRemoteScreenIds: ReadonlySet<string>
  pendingScreenWatchIds?: ReadonlySet<string>
}) {
  return (
    isLocal ||
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

export function pruneWatchedRemoteScreenIds(
  watchedRemoteScreenIds: Set<string>,
  visibleRemoteScreenIds: ReadonlySet<string>,
  remoteParticipantUserIds: ReadonlySet<string>,
) {
  for (const mediaId of Array.from(watchedRemoteScreenIds)) {
    if (visibleRemoteScreenIds.has(mediaId)) continue

    const userId = stageScreenMediaUserId(mediaId)
    if (userId && remoteParticipantUserIds.has(userId)) continue

    watchedRemoteScreenIds.delete(mediaId)
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
