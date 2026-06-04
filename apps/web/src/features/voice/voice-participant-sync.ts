import type { LocalParticipant, RemoteParticipant, Room } from 'livekit-client'

import { syncStore } from '#/features/sync/sync-store'
import { isResolvableVoiceParticipant } from '#/features/sync/voice-participant-resolve'
import type { UserVoiceState } from '#/features/sync/voice-types'
import {
  localParticipantVoiceFlags,
  participantMicPublishing,
  remoteParticipantVoiceFlags,
} from '#/features/voice/voice-participant-media'

function participantState(
  userId: string,
  options: {
    isPublishing: boolean
    isReceiving: boolean
    camera?: boolean
    screensharing?: boolean
    joinedAt?: number
  },
): UserVoiceState {
  return {
    id: userId,
    joined_at: options.joinedAt ?? Date.now(),
    is_publishing: options.isPublishing,
    is_receiving: options.isReceiving,
    camera: options.camera ?? false,
    screensharing: options.screensharing ?? false,
  }
}

function localVoiceState(
  participant: LocalParticipant,
  isReceiving: boolean,
): UserVoiceState {
  const media = localParticipantVoiceFlags(participant)
  return participantState(participant.identity, {
    isPublishing: participantMicPublishing(participant),
    isReceiving,
    camera: media.camera,
    screensharing: media.screensharing,
    joinedAt: participant.joinedAt?.getTime(),
  })
}

function remoteVoiceState(participant: RemoteParticipant): UserVoiceState {
  const media = remoteParticipantVoiceFlags(participant)
  return participantState(participant.identity, {
    isPublishing: participantMicPublishing(participant),
    isReceiving: true,
    camera: media.camera,
    screensharing: media.screensharing,
    joinedAt: participant.joinedAt?.getTime(),
  })
}

/** Участники комнаты LiveKit (identity = user id). */
export function liveKitChannelParticipants(
  room: Room,
  isReceiving: boolean,
): UserVoiceState[] {
  const merged = new Map<string, UserVoiceState>()

  const local = localVoiceState(room.localParticipant, isReceiving)
  merged.set(local.id, local)

  for (const remote of room.remoteParticipants.values()) {
    const state = remoteVoiceState(remote)
    merged.set(state.id, state)
  }

  return [...merged.values()]
}

/** Синхронизирует LiveKit в store; «призраков» без user в sync не сохраняем. */
export function syncLiveKitRoomParticipants(
  channelId: string,
  room: Room,
  isReceiving: boolean,
) {
  const fromRoom = liveKitChannelParticipants(room, isReceiving)
  const syncState = syncStore.getState()
  const localUserId = room.localParticipant.identity
  const liveIds = new Set(fromRoom.map((participant) => participant.id))
  const existing = syncState.voiceParticipants[channelId] ?? {}

  const byId = new Map<string, UserVoiceState>()
  for (const participant of fromRoom) {
    if (participant.id === localUserId) {
      byId.set(participant.id, participant)
      continue
    }

    const existingParticipant = existing[participant.id]
    byId.set(
      participant.id,
      existingParticipant
        ? { ...participant, is_receiving: existingParticipant.is_receiving }
        : participant,
    )
  }

  for (const [id, participant] of Object.entries(existing)) {
    if (liveIds.has(id)) continue
    if (
      isResolvableVoiceParticipant(syncState, id, localUserId)
    ) {
      byId.set(id, participant)
    }
  }

  syncStore.setChannelVoiceParticipants(channelId, [...byId.values()])
}

export function removeLocalVoiceParticipant(channelId: string, userId: string) {
  syncStore.removeVoiceParticipant(channelId, userId)
}

/** Убирает локального пользователя из всех каналов в UI (перед сменой войса). */
export function removeLocalUserFromAllVoiceChannels(userId: string) {
  syncStore.removeVoiceParticipantFromAllChannels(userId)
}

export function patchLocalVoiceMic(
  channelId: string,
  userId: string,
  micEnabled: boolean,
) {
  syncStore.patchVoiceParticipant(channelId, userId, {
    is_publishing: micEnabled,
  })
}

export function patchLocalVoiceDeafen(
  channelId: string,
  userId: string,
  deafened: boolean,
) {
  syncStore.patchVoiceParticipant(channelId, userId, {
    is_receiving: !deafened,
  })
}
