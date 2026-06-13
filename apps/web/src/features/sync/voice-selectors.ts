import { useMemo } from 'react'

import type { SyncState } from './types'
import type { UserVoiceState } from './voice-types'
import {
  isResolvableVoiceParticipant,
} from './voice-participant-resolve'

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
    .sort((a, b) => {
      // Демонстрация экрана приоритетнее: таких участников показываем первыми.
      if (a.screensharing !== b.screensharing) {
        return a.screensharing ? -1 : 1
      }
      return a.joined_at - b.joined_at
    })
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

export type LocalVoiceSessionOverride = {
  userId: string
  micEnabled: boolean
  deafened: boolean
}

/** Оптимистичный override для «Вы» до echo-события с сервера. */
export function applyLocalVoiceSessionOverride(
  participants: UserVoiceState[],
  override: LocalVoiceSessionOverride | undefined,
) {
  if (!override) return participants
  let foundLocalParticipant = false
  const next = participants.map((participant) => {
    if (participant.id !== override.userId) return participant

    foundLocalParticipant = true
    return {
      ...participant,
      self_mute: !override.micEnabled,
      self_deaf: override.deafened,
    }
  })

  if (foundLocalParticipant) return next

  return [
    ...next,
    {
      id: override.userId,
      joined_at: 0,
      self_mute: !override.micEnabled,
      self_deaf: override.deafened,
      server_muted: false,
      server_deafened: false,
      camera: false,
      screensharing: false,
      version: 0,
    },
  ]
}

export function useChannelVoiceParticipantsWithLocalOverride(
  channelId: string,
  storeParticipants: UserVoiceState[],
  localUserId?: string,
  localMicEnabled?: boolean,
  localDeafened?: boolean,
) {
  return useMemo(() => {
    const localSession =
      localUserId != null && localMicEnabled != null && localDeafened != null
        ? {
            userId: localUserId,
            micEnabled: localMicEnabled,
            deafened: localDeafened,
          }
        : undefined
    return applyLocalVoiceSessionOverride(storeParticipants, localSession)
  }, [
    channelId,
    localDeafened,
    localMicEnabled,
    localUserId,
    storeParticipants,
  ])
}

export function isParticipantMuted(participant: UserVoiceState) {
  return participant.server_muted || participant.self_mute
}

export function isParticipantDeafened(participant: UserVoiceState) {
  return participant.server_deafened || participant.self_deaf
}
