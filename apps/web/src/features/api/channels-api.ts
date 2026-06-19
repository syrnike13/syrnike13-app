import type {
  Channel,
  CreateWebhookBody,
  DataDefaultChannelPermissions,
  DataEditChannel,
  DataSetRolePermissions,
  Webhook,
} from '@syrnike13/api-types'

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

export async function setChannelRolePermissions(
  token: string,
  channelId: string,
  roleId: string,
  data: DataSetRolePermissions,
) {
  return apiRequest<Channel>(`/channels/${channelId}/permissions/${roleId}`, {
    method: 'PUT',
    token,
    body: data,
  })
}

export async function setDefaultChannelPermissions(
  token: string,
  channelId: string,
  data: DataDefaultChannelPermissions,
) {
  return apiRequest<Channel>(`/channels/${channelId}/permissions/default`, {
    method: 'PUT',
    token,
    body: data,
  })
}

export async function fetchChannelWebhooks(token: string, channelId: string) {
  return apiRequest<Webhook[]>(`/channels/${channelId}/webhooks`, {
    token,
  })
}

export async function createChannelWebhook(
  token: string,
  channelId: string,
  data: CreateWebhookBody,
) {
  return apiRequest<Webhook>(`/channels/${channelId}/webhooks`, {
    method: 'POST',
    token,
    body: data,
  })
}

export async function deleteWebhook(token: string, webhookId: string) {
  return apiRequest<void>(`/webhooks/${webhookId}`, {
    method: 'DELETE',
    token,
  })
}

export async function cancelDirectMessageCall(
  token: string,
  channelId: string,
) {
  return apiRequest<void>(`/channels/${channelId}/voice/cancel`, {
    method: 'PUT',
    token,
  })
}

export async function declineDirectMessageCall(
  token: string,
  channelId: string,
) {
  return apiRequest<void>(`/channels/${channelId}/voice/decline`, {
    method: 'PUT',
    token,
  })
}
