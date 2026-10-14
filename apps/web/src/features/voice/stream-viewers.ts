import type { SoundEventId } from '#/features/sounds/sound-events'
import type { UserVoiceState } from '#/features/sync/voice-types'

/** Above this many viewers, join/leave sounds would only be noise. */
export const STREAM_VIEWER_SOUND_LIMIT = 25

/**
 * Users watching `ownerId`'s screen share, in participant order. Viewers are
 * counted per user, so several clients of one account are one viewer.
 */
export function streamViewerIds(
  participants: readonly UserVoiceState[],
  ownerId: string,
): string[] {
  const owner = participants.find((participant) => participant.id === ownerId)
  if (!owner?.screensharing) return []
  return participants
    .filter(
      (participant) =>
        participant.id !== ownerId && participant.watching.includes(ownerId),
    )
    .map((participant) => participant.id)
}

export type StreamViewerSnapshot = Readonly<{
  channelId: string | null
  streamOwnerId: string | null
  viewerCount: number
}>

/**
 * The stream whose audience the user hears about: the only stream it shares
 * or watches, or its own stream when there are several.
 */
export function streamViewerSnapshot({
  channelId,
  currentUserId,
  participants,
  watchedOwnerIds,
}: {
  channelId: string | null
  currentUserId: string | null
  participants: readonly UserVoiceState[]
  watchedOwnerIds: readonly string[]
}): StreamViewerSnapshot {
  const empty = { channelId, streamOwnerId: null, viewerCount: 0 }
  if (!channelId || !currentUserId) return empty

  const sharing = new Set(
    participants
      .filter((participant) => participant.screensharing)
      .map((participant) => participant.id),
  )
  const ownStream = sharing.has(currentUserId)
  const activeOwnerIds = [
    ...(ownStream ? [currentUserId] : []),
    ...watchedOwnerIds.filter(
      (ownerId) => ownerId !== currentUserId && sharing.has(ownerId),
    ),
  ]
  const streamOwnerId = activeOwnerIds.length === 1
    ? activeOwnerIds[0]
    : ownStream
      ? currentUserId
      : null
  if (!streamOwnerId) return empty

  return {
    channelId,
    streamOwnerId,
    viewerCount: streamViewerIds(participants, streamOwnerId).filter(
      (viewerId) => viewerId !== currentUserId,
    ).length,
  }
}

/** A viewer sound only when the audience of the same stream changes. */
export function streamViewerTransitionSound(
  previous: StreamViewerSnapshot,
  next: StreamViewerSnapshot,
): SoundEventId | null {
  if (
    previous.channelId !== next.channelId ||
    !previous.streamOwnerId ||
    previous.streamOwnerId !== next.streamOwnerId ||
    previous.viewerCount > STREAM_VIEWER_SOUND_LIMIT
  ) {
    return null
  }
  if (next.viewerCount > previous.viewerCount) return 'screen_share.viewer_join'
  if (next.viewerCount < previous.viewerCount) return 'screen_share.viewer_leave'
  return null
}

/** The watch list the server should hold: sorted, deduplicated owner ids. */
export function normalizeWatchedOwnerIds(ownerIds: readonly string[]) {
  return [...new Set(ownerIds)].sort()
}

export function sameWatchedOwnerIds(
  left: readonly string[],
  right: readonly string[],
) {
  return left.length === right.length &&
    left.every((ownerId, index) => ownerId === right[index])
}
