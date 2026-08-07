import type {
  DataBanCreate,
  DataCreateRole,
  DataCreateServer,
  DataCreateServerChannel,
  DataEditRole,
  DataEditRoleRanks,
  DataEditServer,
  DataMemberEdit,
  DataModerationAction,
  DataPermissionsValue,
  DataSetServerRolePermission,
  ServerAuditLogAction,
  ServerAuditLogTarget,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const editServerEffect = Effect.fn('web.servers.edit')(
  function*(token: string, serverId: string, data: DataEditServer) {
    return yield* apiRequestEffect(
      `/servers/${serverId}`,
      ApiSchema.ServerEditEdit200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function editServer(
  token: string,
  serverId: string,
  data: DataEditServer,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    editServerEffect(token, serverId, data),
    signal ? { signal } : undefined,
  )
}

export const createServerEffect = Effect.fn('web.servers.create')(
  function*(token: string, data: DataCreateServer) {
    return yield* apiRequestEffect(
      '/servers/create',
      ApiSchema.ServerCreateCreateServer200,
      {
        method: 'POST',
        token,
        body: data,
      },
    )
  },
)

export function createServer(
  token: string,
  data: DataCreateServer,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createServerEffect(token, data),
    signal ? { signal } : undefined,
  )
}

export const fetchServerMembersEffect = Effect.fn(
  'web.servers.fetchMembers',
)(function*(token: string, serverId: string) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/members`,
    ApiSchema.MemberFetchAllFetchAll200,
    { token },
  )
})

export function fetchServerMembers(
  token: string,
  serverId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchServerMembersEffect(token, serverId),
    signal ? { signal } : undefined,
  )
}

export const fetchServerInvitesEffect = Effect.fn(
  'web.servers.fetchInvites',
)(function*(token: string, serverId: string) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/invites`,
    ApiSchema.InvitesFetchInvites200,
    { token },
  )
})

export function fetchServerInvites(
  token: string,
  serverId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchServerInvitesEffect(token, serverId),
    signal ? { signal } : undefined,
  )
}

export const fetchServerBansEffect = Effect.fn('web.servers.fetchBans')(
  function*(token: string, serverId: string) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/bans`,
      ApiSchema.BanListList200,
      { token },
    )
  },
)

export function fetchServerBans(
  token: string,
  serverId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchServerBansEffect(token, serverId),
    signal ? { signal } : undefined,
  )
}

export type FetchServerAuditLogParams = {
  before?: string
  actor?: string
  action?: ServerAuditLogAction['type']
  target_type?: ServerAuditLogTarget['type']
  target_id?: string
  limit?: number
}

export const fetchServerAuditLogEffect = Effect.fn(
  'web.servers.fetchAuditLog',
)(function*(
  token: string,
  serverId: string,
  params: FetchServerAuditLogParams = {},
) {
  const search = new URLSearchParams()
  if (params.before) search.set('before', params.before)
  if (params.actor) search.set('actor', params.actor)
  if (params.action) search.set('action', params.action)
  if (params.target_type) search.set('target_type', params.target_type)
  if (params.target_id) search.set('target_id', params.target_id)
  if (params.limit) search.set('limit', String(params.limit))
  const suffix = search.toString() ? `?${search}` : ''

  return yield* apiRequestEffect(
    `/servers/${serverId}/audit-log${suffix}`,
    ApiSchema.AuditLogFetchAuditLog200,
    { token },
  )
})

export function fetchServerAuditLog(
  token: string,
  serverId: string,
  params: FetchServerAuditLogParams = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchServerAuditLogEffect(token, serverId, params),
    signal ? { signal } : undefined,
  )
}

export const createServerChannelEffect = Effect.fn(
  'web.servers.createChannel',
)(function*(
  token: string,
  serverId: string,
  data: DataCreateServerChannel,
) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/channels`,
    ApiSchema.ChannelCreateCreateServerChannel200,
    {
      method: 'POST',
      token,
      body: data,
    },
  )
})

export function createServerChannel(
  token: string,
  serverId: string,
  data: DataCreateServerChannel,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createServerChannelEffect(token, serverId, data),
    signal ? { signal } : undefined,
  )
}

export const ackServerEffect = Effect.fn('web.servers.ack')(
  function*(token: string, serverId: string) {
    return yield* apiRequestEffect(`/servers/${serverId}/ack`, Schema.Void, {
      method: 'PUT',
      token,
    })
  },
)

export function ackServer(token: string, serverId: string) {
  return Effect.runPromise(ackServerEffect(token, serverId))
}

export const deleteOrLeaveServerEffect = Effect.fn(
  'web.servers.deleteOrLeave',
)(function*(token: string, serverId: string) {
  const search = new URLSearchParams({
    leave_silently: 'false',
  })

  return yield* apiRequestEffect(
    `/servers/${serverId}?${search}`,
    Schema.Void,
    {
      method: 'DELETE',
      token,
    },
  )
})

export function deleteOrLeaveServer(
  token: string,
  serverId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteOrLeaveServerEffect(token, serverId),
    signal ? { signal } : undefined,
  )
}

export const fetchServerEmojisEffect = Effect.fn(
  'web.servers.fetchEmojis',
)(function*(token: string, serverId: string) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/emojis`,
    ApiSchema.EmojiListListEmoji200,
    { token },
  )
})

export function fetchServerEmojis(
  token: string,
  serverId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchServerEmojisEffect(token, serverId),
    signal ? { signal } : undefined,
  )
}

export const createServerEmojiEffect = Effect.fn(
  'web.servers.createEmoji',
)(function*(
  token: string,
  autumnId: string,
  serverId: string,
  name: string,
) {
  return yield* apiRequestEffect(
    `/custom/emoji/${autumnId}`,
    ApiSchema.EmojiCreateCreateEmoji200,
    {
      method: 'PUT',
      token,
      body: {
        name,
        parent: { type: 'Server', id: serverId },
      },
    },
  )
})

export function createServerEmoji(
  token: string,
  autumnId: string,
  serverId: string,
  name: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createServerEmojiEffect(token, autumnId, serverId, name),
    signal ? { signal } : undefined,
  )
}

export const deleteServerEmojiEffect = Effect.fn(
  'web.servers.deleteEmoji',
)(function*(token: string, emojiId: string) {
  return yield* apiRequestEffect(`/custom/emoji/${emojiId}`, Schema.Void, {
    method: 'DELETE',
    token,
  })
})

export function deleteServerEmoji(
  token: string,
  emojiId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteServerEmojiEffect(token, emojiId),
    signal ? { signal } : undefined,
  )
}

export type FetchServerMemberOptions = {
  roles?: boolean
  signal?: AbortSignal
}

type FetchServerMemberEffectOptions = Omit<
  FetchServerMemberOptions,
  'signal'
>

export const fetchServerMemberEffect = Effect.fn(
  'web.servers.fetchMember',
)(function*(
  token: string,
  serverId: string,
  userId: string,
  options: FetchServerMemberEffectOptions = {},
) {
  const query = options.roles ? '?roles=true' : ''
  return yield* apiRequestEffect(
    `/servers/${serverId}/members/${userId}${query}`,
    ApiSchema.MemberFetchFetch200,
    { token },
  )
})

export function fetchServerMember(
  token: string,
  serverId: string,
  userId: string,
  options: FetchServerMemberOptions = {},
) {
  const { signal, ...effectOptions } = options
  return Effect.runPromise(
    fetchServerMemberEffect(token, serverId, userId, effectOptions),
    signal ? { signal } : undefined,
  )
}

export const editServerMemberEffect = Effect.fn('web.servers.editMember')(
  function*(
    token: string,
    serverId: string,
    userId: string,
    data: DataMemberEdit,
  ) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/members/${userId}`,
      ApiSchema.MemberEditEdit200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function editServerMember(
  token: string,
  serverId: string,
  userId: string,
  data: DataMemberEdit,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    editServerMemberEffect(token, serverId, userId, data),
    signal ? { signal } : undefined,
  )
}

export const kickServerMemberEffect = Effect.fn('web.servers.kickMember')(
  function*(
    token: string,
    serverId: string,
    userId: string,
    body: DataModerationAction = {},
  ) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/members/${userId}`,
      Schema.Void,
      {
        method: 'DELETE',
        token,
        body,
      },
    )
  },
)

export function kickServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataModerationAction = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    kickServerMemberEffect(token, serverId, userId, body),
    signal ? { signal } : undefined,
  )
}

export const banServerMemberEffect = Effect.fn('web.servers.banMember')(
  function*(
    token: string,
    serverId: string,
    userId: string,
    body: DataBanCreate = {},
  ) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/bans/${userId}`,
      ApiSchema.BanCreateBan200,
      {
        method: 'PUT',
        token,
        body,
      },
    )
  },
)

export function banServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataBanCreate = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    banServerMemberEffect(token, serverId, userId, body),
    signal ? { signal } : undefined,
  )
}

export const unbanServerMemberEffect = Effect.fn('web.servers.unbanMember')(
  function*(
    token: string,
    serverId: string,
    userId: string,
    body: DataModerationAction = {},
  ) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/bans/${userId}`,
      Schema.Void,
      {
        method: 'DELETE',
        token,
        body,
      },
    )
  },
)

export function unbanServerMember(
  token: string,
  serverId: string,
  userId: string,
  body: DataModerationAction = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    unbanServerMemberEffect(token, serverId, userId, body),
    signal ? { signal } : undefined,
  )
}

export const createServerRoleEffect = Effect.fn('web.servers.createRole')(
  function*(token: string, serverId: string, data: DataCreateRole) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/roles`,
      ApiSchema.RolesCreateCreate200,
      {
        method: 'POST',
        token,
        body: data,
      },
    )
  },
)

export function createServerRole(
  token: string,
  serverId: string,
  data: DataCreateRole,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createServerRoleEffect(token, serverId, data),
    signal ? { signal } : undefined,
  )
}

export const editServerRoleEffect = Effect.fn('web.servers.editRole')(
  function*(
    token: string,
    serverId: string,
    roleId: string,
    data: DataEditRole,
  ) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/roles/${roleId}`,
      ApiSchema.RolesEditEdit200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function editServerRole(
  token: string,
  serverId: string,
  roleId: string,
  data: DataEditRole,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    editServerRoleEffect(token, serverId, roleId, data),
    signal ? { signal } : undefined,
  )
}

export const deleteServerRoleEffect = Effect.fn('web.servers.deleteRole')(
  function*(token: string, serverId: string, roleId: string) {
    return yield* apiRequestEffect(
      `/servers/${serverId}/roles/${roleId}`,
      Schema.Void,
      {
        method: 'DELETE',
        token,
      },
    )
  },
)

export function deleteServerRole(
  token: string,
  serverId: string,
  roleId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteServerRoleEffect(token, serverId, roleId),
    signal ? { signal } : undefined,
  )
}

export const setServerRolePermissionsEffect = Effect.fn(
  'web.servers.setRolePermissions',
)(function*(
  token: string,
  serverId: string,
  roleId: string,
  data: DataSetServerRolePermission,
) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/permissions/${roleId}`,
    ApiSchema.PermissionsSetSetRolePermission200,
    {
      method: 'PUT',
      token,
      body: data,
    },
  )
})

export function setServerRolePermissions(
  token: string,
  serverId: string,
  roleId: string,
  data: DataSetServerRolePermission,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    setServerRolePermissionsEffect(token, serverId, roleId, data),
    signal ? { signal } : undefined,
  )
}

export const setDefaultServerPermissionsEffect = Effect.fn(
  'web.servers.setDefaultPermissions',
)(function*(
  token: string,
  serverId: string,
  data: DataPermissionsValue,
) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/permissions/default`,
    ApiSchema.PermissionsSetDefaultSetDefaultServerPermissions200,
    {
      method: 'PUT',
      token,
      body: data,
    },
  )
})

export function setDefaultServerPermissions(
  token: string,
  serverId: string,
  data: DataPermissionsValue,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    setDefaultServerPermissionsEffect(token, serverId, data),
    signal ? { signal } : undefined,
  )
}

export const editServerRoleRanksEffect = Effect.fn(
  'web.servers.editRoleRanks',
)(function*(token: string, serverId: string, data: DataEditRoleRanks) {
  return yield* apiRequestEffect(
    `/servers/${serverId}/roles/ranks`,
    ApiSchema.RolesEditPositionsEditRoleRanks200,
    {
      method: 'PATCH',
      token,
      body: data,
    },
  )
})

export function editServerRoleRanks(
  token: string,
  serverId: string,
  data: DataEditRoleRanks,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    editServerRoleRanksEffect(token, serverId, data),
    signal ? { signal } : undefined,
  )
}
