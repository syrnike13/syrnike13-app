import type { ChannelUnread } from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function fetchUnreads(token: string) {
  return apiRequest<ChannelUnread[]>('/sync/unreads', { token })
}

export async function ackChannel(
  token: string,
  channelId: string,
  messageId: string,
) {
  return apiRequest(`/channels/${channelId}/ack/${messageId}`, {
    method: 'PUT',
    token,
  })
}
