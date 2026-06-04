import type {
  Channel,
  DataCreateServer,
  DataCreateServerChannel,
  DataEditServer,
  Emoji,
  Invite,
  Member,
  Server,
  User,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

type CreateServerResponse = {
  server: Server
  channels: Channel[]
}

export async function editServer(
  token: string,
  serverId: string,
  data: DataEditServer,
) {
  return apiRequest<Server>(`/servers/${serverId}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function createServer(token: string, data: DataCreateServer) {
  return apiRequest<CreateServerResponse>('/servers/create', {
    method: 'POST',
    token,
    body: data,
  })
}

export async function fetchServerMembers(token: string, serverId: string) {
  return apiRequest<{ members: Member[]; users: User[] }>(
    `/servers/${serverId}/members`,
    { token },
  )
}

export async function fetchServerInvites(token: string, serverId: string) {
  return apiRequest<Invite[]>(`/servers/${serverId}/invites`, { token })
}

export async function createServerChannel(
  token: string,
  serverId: string,
  data: DataCreateServerChannel,
) {
  return apiRequest<Channel>(`/servers/${serverId}/channels`, {
    method: 'POST',
    token,
    body: data,
  })
}

export async function ackServer(token: string, serverId: string) {
  return apiRequest<void>(`/servers/${serverId}/ack`, {
    method: 'PUT',
    token,
  })
}

export async function leaveServer(token: string, serverId: string) {
  return apiRequest<void>(`/servers/${serverId}`, {
    method: 'DELETE',
    token,
    body: { leave_silently: false },
  })
}

export async function fetchServerEmojis(token: string, serverId: string) {
  return apiRequest<Emoji[]>(`/servers/${serverId}/emojis`, { token })
}

export async function createServerEmoji(
  token: string,
  autumnId: string,
  serverId: string,
  name: string,
) {
  return apiRequest<Emoji>(`/custom/emoji/${autumnId}`, {
    method: 'PUT',
    token,
    body: {
      name,
      parent: { type: 'Server', id: serverId },
    },
  })
}

export async function deleteServerEmoji(token: string, emojiId: string) {
  return apiRequest<void>(`/custom/emoji/${emojiId}`, {
    method: 'DELETE',
    token,
  })
}

export async function kickServerMember(
  token: string,
  serverId: string,
  userId: string,
) {
  return apiRequest<void>(`/servers/${serverId}/members/${userId}`, {
    method: 'DELETE',
    token,
  })
}

export async function banServerMember(
  token: string,
  serverId: string,
  userId: string,
) {
  return apiRequest<void>(`/servers/${serverId}/bans/${userId}`, {
    method: 'PUT',
    token,
  })
}

export async function createChannelInvite(token: string, channelId: string) {
  return apiRequest<Invite>(`/channels/${channelId}/invites`, {
    method: 'POST',
    token,
  })
}
