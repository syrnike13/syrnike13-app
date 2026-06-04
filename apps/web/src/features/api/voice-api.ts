import type { CreateVoiceUserResponse, DataJoinCall } from '@syrnike13/api-types'

import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import { apiRequest } from '#/lib/api/client'
import type { ChannelVoiceState } from '#/features/sync/voice-types'

export type ChannelVoiceStateResponse = ChannelVoiceState

export async function fetchChannelVoiceState(token: string, channelId: string) {
  return apiRequest<ChannelVoiceStateResponse>(
    `/channels/${channelId}/voice_state`,
    { token, cache: 'no-store' },
  )
}

export async function joinChannelCall(
  token: string,
  channelId: string,
  options?: Pick<DataJoinCall, 'node' | 'force_disconnect' | 'recipients'>,
) {
  const node = options?.node ?? (await resolveVoiceNodeName())
  const body: DataJoinCall = {
    force_disconnect: options?.force_disconnect ?? true,
    node,
    ...(options?.recipients ? { recipients: options.recipients } : {}),
  }

  return apiRequest<CreateVoiceUserResponse>(
    `/channels/${channelId}/join_call`,
    { method: 'POST', token, body },
  )
}
