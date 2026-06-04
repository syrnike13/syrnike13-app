import type { Channel, DataEditChannel } from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function editChannel(
  token: string,
  channelId: string,
  data: DataEditChannel,
) {
  return apiRequest<Channel>(`/channels/${channelId}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function createGroupChannel(
  token: string,
  name: string,
  userIds: string[],
) {
  return apiRequest<Channel>('/channels/create', {
    method: 'POST',
    token,
    body: { name, users: userIds },
  })
}

export async function deleteChannel(
  token: string,
  channelId: string,
  leaveSilently = false,
) {
  return apiRequest<void>(`/channels/${channelId}`, {
    method: 'DELETE',
    token,
    body: { leave_silently: leaveSilently },
  })
}
