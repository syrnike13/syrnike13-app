import type {
  Channel,
  DataCreateRole,
  DataCreateServer,
  DataCreateServerChannel,
  DataBanCreate,
  DataEditRole,
  DataEditRoleRanks,
  DataEditServer,
  DataMemberEdit,
  DataModerationAction,
  DataPermissionsValue,
  DataSetServerRolePermission,
  MemberResponse,
  BanListResult,
  Emoji,
  Invite,
  Member,
  NewRoleResponse,
  Role,
  Server,
  ServerAuditLogAction,
  ServerAuditLogPage,
  ServerAuditLogTarget,
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

export async function fetchServerBans(token: string, serverId: string) {
  return apiRequest<BanListResult>(`/servers/${serverId}/bans`, { token })
}

export async function fetchServerAuditLog(
  token: string,
  serverId: string,
  params: {
    before?: string
    actor?: string
    action?: ServerAuditLogAction['type']
    target_type?: ServerAuditLogTarget['type']
    target_id?: string
    limit?: number
  } = {},
) {
  const search = new URLSearchParams()
  if (params.before) search.set('before', params.before)
  if (params.actor) search.set('actor', params.actor)
  if (params.action) search.set('action', params.action)
  if (params.target_type) search.set('target_type', params.target_type)
  if (params.target_id) search.set('target_id', params.target_id)
  if (params.limit) search.set('limit', String(params.limit))
  const suffix = search.toString() ? `?${search}` : ''

  return apiRequest<ServerAuditLogPage>(
    `/servers/${serverId}/audit-log${suffix}`,
    { token },
  )
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

export async function deleteOrLeaveServer(token: string, serverId: string) {
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

export async function fetchServerMember(
  token: string,
  serverId: string,
  userId: string,
  options: { roles?: boolean } = {},
) {
  const query = options.roles ? '?roles=true' : ''
  return apiRequest<MemberResponse>(
    `/servers/${serverId}/members/${userId}${query}`,
    { token },
  )
}

export async function editServerMember(
  token: string,
  serverId: string,
  userId: string,
  data: DataMemberEdit,
) {
  return apiRequest<Member>(`/servers/${serverId}/members/${userId}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function kickServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataModerationAction = {},
) {
  return apiRequest<void>(`/servers/${serverId}/members/${userId}`, {
    method: 'DELETE',
    token,
    body,
  })
}

export async function banServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataBanCreate = {},
) {
  return apiRequest<void>(`/servers/${serverId}/bans/${userId}`, {
    method: 'PUT',
    token,
    body,
  })
}

export async function unbanServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataModerationAction = {},
) {
  return apiRequest<void>(`/servers/${serverId}/bans/${userId}`, {
    method: 'DELETE',
    token,
    body,
  })
}

export async function createServerRole(
  token: string,
  serverId: string,
  data: DataCreateRole,
) {
  return apiRequest<NewRoleResponse>(`/servers/${serverId}/roles`, {
    method: 'POST',
    token,
    body: data,
  })
}

export async function editServerRole(
  token: string,
  serverId: string,
  roleId: string,
  data: DataEditRole,
) {
  return apiRequest<Role>(`/servers/${serverId}/roles/${roleId}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function deleteServerRole(
  token: string,
  serverId: string,
  roleId: string,
) {
  return apiRequest<void>(`/servers/${serverId}/roles/${roleId}`, {
    method: 'DELETE',
    token,
  })
}

export async function setServerRolePermissions(
  token: string,
  serverId: string,
  roleId: string,
  data: DataSetServerRolePermission,
) {
  return apiRequest<Server>(`/servers/${serverId}/permissions/${roleId}`, {
    method: 'PUT',
    token,
    body: data,
  })
}

export async function setDefaultServerPermissions(
  token: string,
  serverId: string,
  data: DataPermissionsValue,
) {
  return apiRequest<Server>(`/servers/${serverId}/permissions/default`, {
    method: 'PUT',
    token,
    body: data,
  })
}

export async function editServerRoleRanks(
  token: string,
  serverId: string,
  data: DataEditRoleRanks,
) {
  return apiRequest<Server>(`/servers/${serverId}/roles/ranks`, {
    method: 'PATCH',
    token,
    body: data,
  })
}
