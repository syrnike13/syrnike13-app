import type { Room } from 'livekit-client'

import { syncStore } from '#/features/sync/sync-store'
import { isValidVoiceUserId } from '#/features/sync/voice-participant-resolve'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'

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
    self_mute: !micEnabled,
  })
}

export function patchLocalVoiceDeafen(
  channelId: string,
  userId: string,
  deafened: boolean,
) {
  syncStore.patchVoiceParticipant(channelId, userId, {
    self_deaf: deafened,
    ...(deafened ? { self_mute: true } : {}),
  })
}

/** Только id участников комнаты — для stage media, не для mute/deafen. */
export function liveKitRoomParticipantIds(
  room: Room,
  options: {
    excludedParticipantIdentities?: ReadonlySet<string>
  } = {},
) {
  const ids: string[] = []
  const localId = baseVoiceIdentity(room.localParticipant.identity)
  if (
    isValidVoiceUserId(localId) &&
    !options.excludedParticipantIdentities?.has(room.localParticipant.identity)
  ) {
    ids.push(localId)
  }
  for (const remote of room.remoteParticipants.values()) {
    if (options.excludedParticipantIdentities?.has(remote.identity)) continue
    const userId = baseVoiceIdentity(remote.identity)
    if (!isValidVoiceUserId(userId)) continue
    ids.push(userId)
  }
  return ids
}
