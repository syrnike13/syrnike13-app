import type {
  Channel,
  CreateWebhookBody,
  DataEditChannel,
  DataEditWebhook,
  DataSetRolePermissions,
  DataSetUserPermissions,
  User,
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

export async function fetchGroupMembers(token: string, groupId: string) {
  return apiRequest<User[]>(`/channels/${groupId}/members`, { token })
}

export async function addGroupMember(
  token: string,
  groupId: string,
  userId: string,
) {
  return apiRequest<void>(`/channels/${groupId}/recipients/${userId}`, {
    method: 'PUT',
    token,
  })
}

export async function removeGroupMember(
  token: string,
  groupId: string,
  userId: string,
) {
  return apiRequest<void>(`/channels/${groupId}/recipients/${userId}`, {
    method: 'DELETE',
    token,
  })
}

export async function transferGroupOwnership(
  token: string,
  groupId: string,
  ownerId: string,
) {
  return apiRequest<Channel>(`/channels/${groupId}`, {
    method: 'PATCH',
    token,
    body: { owner: ownerId },
  })
}

export async function deleteChannel(
  token: string,
  channelId: string,
  leaveSilently = false,
) {
  const search = new URLSearchParams({
    leave_silently: String(leaveSilently),
  })

  return apiRequest<void>(`/channels/${channelId}?${search}`, {
    method: 'DELETE',
    token,
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

export async function setChannelUserPermissions(
  token: string,
  channelId: string,
  userId: string,
  data: DataSetUserPermissions,
) {
  return apiRequest<Channel>(
    `/channels/${channelId}/permissions/users/${userId}`,
    {
      method: 'PUT',
      token,
      body: data,
    },
  )
}

export async function setDefaultChannelPermissions(
  token: string,
  channelId: string,
  data: { permissions: number } | DataSetRolePermissions,
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

export async function editWebhook(
  token: string,
  webhookId: string,
  data: DataEditWebhook,
) {
  return apiRequest<Webhook>(`/webhooks/${webhookId}`, {
    method: 'PATCH',
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
