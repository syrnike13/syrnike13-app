import type { UserVoiceState } from '#/features/sync/voice-types'
import {
  stageMediaItemId,
  type StageMediaFilters,
  type StageMediaItem,
} from '#/features/voice/voice-stage-media'

export function createConnectingLocalVoiceState(
  userId: string,
  options: { micEnabled: boolean; deafened: boolean },
): UserVoiceState {
  return {
    id: userId,
    joined_at: Date.now(),
    self_mute: !options.micEnabled,
    self_deaf: options.deafened,
    server_muted: false,
    server_deafened: false,
    camera: false,
    screensharing: false,
    version: 0,
  }
}

export function isVoiceLocalUserId(
  userId: string,
  authUserId?: string,
  liveKitIdentity?: string,
) {
  if (authUserId && userId === authUserId) return true
  return Boolean(liveKitIdentity && userId === liveKitIdentity)
}

/** Плитка «я» на стейдже, пока LiveKit ещё не отдал медиа. */
export function withConnectingLocalAvatarItem<T extends StageMediaItem>(
  items: readonly T[],
  options: {
    connecting: boolean
    localUserId?: string
    filters: StageMediaFilters
  },
): T[] {
  if (!options.connecting || !options.localUserId) return [...items]
  if (
    !options.filters.showOwnStream ||
    !options.filters.showParticipantsWithoutMedia
  ) {
    return [...items]
  }
  if (items.some((item) => item.userId === options.localUserId)) {
    return [...items]
  }

  const preview = {
    id: stageMediaItemId(options.localUserId, 'avatar'),
    userId: options.localUserId,
    kind: 'avatar' as const,
    isLocal: true,
    live: false,
    pending: true,
  }

  return [...items, preview as T]
}
