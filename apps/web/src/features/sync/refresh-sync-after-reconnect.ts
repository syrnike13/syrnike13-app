import { fetchUnreads } from '#/features/api/sync-api'

import { ensureVoiceUsersLoaded } from './ensure-voice-users'
import { syncStore } from './sync-store'

export async function refreshSyncAfterReconnect(
  token: string,
  currentUserId: string | undefined,
) {
  try {
    const unreads = await fetchUnreads(token)
    syncStore.setUnreads(unreads)
  } catch {
    // unreads optional if endpoint fails
  }

  const voiceParticipants = syncStore.getState().voiceParticipants
  const userIds = Object.values(voiceParticipants).flatMap((channelMap) =>
    Object.keys(channelMap),
  )
  ensureVoiceUsersLoaded(userIds.filter(Boolean), token)
  syncStore.pruneUnknownVoiceParticipants(currentUserId)
}
