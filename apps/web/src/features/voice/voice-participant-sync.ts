import { syncStore } from '#/features/sync/sync-store'
import { isValidVoiceUserId } from '#/features/sync/voice-participant-resolve'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'

type LiveKitRoomParticipantSource = {
  localParticipant: { identity: string }
  remoteParticipants: { values(): Iterable<{ identity: string }> }
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

export function patchLocalVoiceCamera(
  channelId: string,
  userId: string,
  cameraEnabled: boolean,
) {
  syncStore.patchVoiceParticipant(channelId, userId, {
    camera: cameraEnabled,
  })
}

/** Только id участников комнаты — для stage media, не для mute/deafen. */
export function liveKitRoomParticipantIds(
  room: LiveKitRoomParticipantSource,
  options: {
    excludedParticipantIdentities?: ReadonlySet<string>
  } = {},
) {
  const ids = new Set<string>()
  const addIdentity = (identity: string) => {
    if (options.excludedParticipantIdentities?.has(identity)) return
    const userId = baseVoiceIdentity(identity)
    if (isValidVoiceUserId(userId)) ids.add(userId)
  }

  addIdentity(room.localParticipant.identity)
  for (const remote of room.remoteParticipants.values()) {
    addIdentity(remote.identity)
  }
  return Array.from(ids)
}
