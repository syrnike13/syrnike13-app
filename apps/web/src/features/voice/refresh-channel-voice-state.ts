import { fetchChannelVoiceState } from '#/features/api/voice-api'
import { ensureVoiceUsersLoaded } from '#/features/sync/ensure-voice-users'
import { syncStore } from '#/features/sync/sync-store'
import {
  channelIdFromVoiceStateEntry,
  normalizeUserVoiceState,
} from '#/features/sync/voice-event-utils'
import type { ChannelVoiceState } from '#/features/sync/voice-types'
import {
  canUseVoiceRestApi,
  handleVoiceApiError,
} from '#/features/voice/voice-api-capability'
import { runVoiceRequest } from '#/features/voice/voice-request-gate'

export function applyChannelVoiceStatePayload(payload: ChannelVoiceState) {
  const channelId = channelIdFromVoiceStateEntry(payload)
  if (!channelId) return undefined

  const participants = (payload.participants ?? [])
    .map((participant) => normalizeUserVoiceState(participant))
    .filter((participant): participant is NonNullable<typeof participant> =>
      Boolean(participant),
    )

  syncStore.setChannelVoiceParticipants(channelId, participants)
  return { channelId, userIds: participants.map((participant) => participant.id) }
}

export async function refreshChannelVoiceState(
  token: string,
  channelId: string,
) {
  const channel = syncStore.getState().channels[channelId]
  if (!canUseVoiceRestApi(channel)) return undefined

  try {
    const payload = await runVoiceRequest(`voice_state:${channelId}`, () =>
      fetchChannelVoiceState(token, channelId),
    )
    if (!payload) return undefined

    const applied = applyChannelVoiceStatePayload(payload)
    if (applied?.userIds.length) {
      ensureVoiceUsersLoaded(applied.userIds, token)
    }
    return payload
  } catch (error) {
    handleVoiceApiError(channelId, error)
    return undefined
  }
}
