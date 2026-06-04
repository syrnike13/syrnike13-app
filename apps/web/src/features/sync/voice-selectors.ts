import { useMemo } from 'react'

import type { SyncState } from './types'
import type { UserVoiceState } from './voice-types'
import { isResolvableVoiceParticipant } from './voice-participant-resolve'

export function getChannelVoiceParticipants(
  state: SyncState,
  channelId: string,
  currentUserId?: string,
): UserVoiceState[] {
  const map = state.voiceParticipants[channelId]
  if (!map) return []
  return Object.values(map)
    .filter((participant) =>
      isResolvableVoiceParticipant(state, participant.id, currentUserId),
    )
    .sort((a, b) => a.joined_at - b.joined_at)
}

export function getChannelVoiceParticipantCount(
  state: SyncState,
  channelId: string,
  currentUserId?: string,
) {
  return getChannelVoiceParticipants(state, channelId, currentUserId).length
}

export function isUserInAnyVoice(state: SyncState, userId: string) {
  for (const channelMap of Object.values(state.voiceParticipants)) {
    if (channelMap[userId]) return true
  }
  return false
}

export function mergeVoiceParticipants(
  storeParticipants: UserVoiceState[],
  liveParticipants: UserVoiceState[],
  localUserId?: string,
): UserVoiceState[] {
  const map = new Map<string, UserVoiceState>()

  for (const participant of storeParticipants) {
    map.set(participant.id, participant)
  }

  for (const participant of liveParticipants) {
    const existing = map.get(participant.id)
    map.set(
      participant.id,
      existing
        ? {
            ...existing,
            ...participant,
            joined_at: Math.min(existing.joined_at, participant.joined_at),
            camera: existing.camera || participant.camera,
            screensharing:
              existing.screensharing || participant.screensharing,
            is_publishing: participant.is_publishing,
            is_receiving:
              participant.id === localUserId
                ? participant.is_receiving
                : existing.is_receiving,
          }
        : participant,
    )
  }

  return [...map.values()].sort((a, b) => a.joined_at - b.joined_at)
}

export type LocalVoiceSessionOverride = {
  userId: string
  micEnabled: boolean
  deafened: boolean
}

/** Сайдбар для «Вы» в активном войсе = те же флаги, что в UserPanel / LiveKit. */
export function applyLocalVoiceSessionOverride(
  participants: UserVoiceState[],
  override: LocalVoiceSessionOverride | undefined,
) {
  if (!override) return participants
  return participants.map((participant) =>
    participant.id === override.userId
      ? {
          ...participant,
          is_publishing: override.micEnabled,
          is_receiving: !override.deafened,
        }
      : participant,
  )
}

export function useMergedChannelVoiceParticipants(
  channelId: string,
  storeParticipants: UserVoiceState[],
  liveParticipants: UserVoiceState[],
  liveActive: boolean,
  localUserId?: string,
  localMicEnabled?: boolean,
  localDeafened?: boolean,
) {
  return useMemo(() => {
    const merged = mergeVoiceParticipants(
      storeParticipants,
      liveActive ? liveParticipants : [],
      localUserId,
    )
    const localSession =
      liveActive && localUserId != null && localMicEnabled != null && localDeafened != null
        ? {
            userId: localUserId,
            micEnabled: localMicEnabled,
            deafened: localDeafened,
          }
        : undefined
    return applyLocalVoiceSessionOverride(merged, localSession)
  }, [
    channelId,
    liveActive,
    liveParticipants,
    localDeafened,
    localMicEnabled,
    localUserId,
    storeParticipants,
  ])
}
