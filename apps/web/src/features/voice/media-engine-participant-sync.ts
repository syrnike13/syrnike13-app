import { syncStore } from '#/features/sync/sync-store'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { isValidVoiceUserId } from '#/features/sync/voice-participant-resolve'

export type EngineParticipantsSnapshot = {
  localUserId: string
  localCamera?: boolean
  localScreensharing?: boolean
  participants: Array<{
    userId: string
    sid: string
    camera?: boolean
    screensharing?: boolean
  }>
}

export type EngineTrackSource = 'screen' | 'camera'

export function applyEngineParticipantsSnapshot(
  channelId: string,
  snapshot: EngineParticipantsSnapshot,
  options: {
    localMicPublishing: boolean
    localReceiving: boolean
  },
) {
  if (!isValidVoiceUserId(snapshot.localUserId)) return

  const existing = syncStore.getState().voiceParticipants[channelId] ?? {}
  const byId = new Map<string, UserVoiceState>(Object.entries(existing))

  const localExisting = byId.get(snapshot.localUserId)
  byId.set(snapshot.localUserId, {
    id: snapshot.localUserId,
    joined_at: localExisting?.joined_at ?? Date.now(),
    is_publishing: options.localMicPublishing,
    is_receiving: options.localReceiving,
    server_muted: localExisting?.server_muted ?? false,
    server_deafened: localExisting?.server_deafened ?? false,
    camera: snapshot.localCamera ?? localExisting?.camera ?? false,
    screensharing:
      snapshot.localScreensharing ?? localExisting?.screensharing ?? false,
  })

  for (const participant of snapshot.participants) {
    if (!isValidVoiceUserId(participant.userId)) continue
    if (participant.userId === snapshot.localUserId) continue

    const previous = byId.get(participant.userId)
    byId.set(participant.userId, {
      id: participant.userId,
      joined_at: previous?.joined_at ?? Date.now(),
      is_publishing: previous?.is_publishing ?? false,
      is_receiving: previous?.is_receiving ?? true,
      server_muted: previous?.server_muted ?? false,
      server_deafened: previous?.server_deafened ?? false,
      camera: participant.camera ?? previous?.camera ?? false,
      screensharing: participant.screensharing ?? previous?.screensharing ?? false,
    })
  }

  syncStore.setChannelVoiceParticipants(channelId, [...byId.values()])
}

export function applyEngineTrackPublished(
  channelId: string,
  userId: string,
  source: EngineTrackSource,
) {
  if (!isValidVoiceUserId(userId)) return

  const patch =
    source === 'screen'
      ? { screensharing: true }
      : { camera: true }

  syncStore.patchVoiceParticipant(channelId, userId, patch)
}

export function applyEngineTrackUnpublished(
  channelId: string,
  userId: string,
  source: EngineTrackSource,
) {
  if (!isValidVoiceUserId(userId)) return

  const patch =
    source === 'screen'
      ? { screensharing: false }
      : { camera: false }

  syncStore.patchVoiceParticipant(channelId, userId, patch)
}
