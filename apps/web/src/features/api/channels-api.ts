import type {
  CreateWebhookBody,
  DataEditChannel,
  DataEditWebhook,
  DataSetRolePermissions,
  DataSetUserPermissions,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const editChannelEffect = Effect.fn('web.channels.edit')(
  function*(token: string, channelId: string, data: DataEditChannel) {
    return yield* apiRequestEffect(
      `/channels/${channelId}`,
      ApiSchema.ChannelEditEdit200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function editChannel(
  token: string,
  channelId: string,
  data: DataEditChannel,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    editChannelEffect(token, channelId, data),
    signal ? { signal } : undefined,
  )
}

export const createGroupChannelEffect = Effect.fn('web.channels.createGroup')(
  function*(token: string, name: string, userIds: string[]) {
    return yield* apiRequestEffect(
      '/channels/create',
      ApiSchema.GroupCreateCreateGroup200,
      {
        method: 'POST',
        token,
        body: { name, users: userIds },
      },
    )
  },
)

export function createGroupChannel(
  token: string,
  name: string,
  userIds: string[],
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createGroupChannelEffect(token, name, userIds),
    signal ? { signal } : undefined,
  )
}

export const fetchGroupMembersEffect = Effect.fn(
  'web.channels.fetchGroupMembers',
)(function*(token: string, groupId: string) {
  return yield* apiRequestEffect(
    `/channels/${groupId}/members`,
    ApiSchema.MembersFetchFetchMembers200,
    { token },
  )
})

export function fetchGroupMembers(
  token: string,
  groupId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchGroupMembersEffect(token, groupId),
    signal ? { signal } : undefined,
  )
}

export const addGroupMemberEffect = Effect.fn('web.channels.addGroupMember')(
  function*(token: string, groupId: string, userId: string) {
    return yield* apiRequestEffect(
      `/channels/${groupId}/recipients/${userId}`,
      Schema.Void,
      {
        method: 'PUT',
        token,
      },
    )
  },
)

export function addGroupMember(
  token: string,
  groupId: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    addGroupMemberEffect(token, groupId, userId),
    signal ? { signal } : undefined,
  )
}

export const removeGroupMemberEffect = Effect.fn(
  'web.channels.removeGroupMember',
)(function*(token: string, groupId: string, userId: string) {
  return yield* apiRequestEffect(
    `/channels/${groupId}/recipients/${userId}`,
    Schema.Void,
    {
      method: 'DELETE',
      token,
    },
  )
})

export function removeGroupMember(
  token: string,
  groupId: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    removeGroupMemberEffect(token, groupId, userId),
    signal ? { signal } : undefined,
  )
}

export const transferGroupOwnershipEffect = Effect.fn(
  'web.channels.transferGroupOwnership',
)(function*(token: string, groupId: string, ownerId: string) {
  return yield* apiRequestEffect(
    `/channels/${groupId}`,
    ApiSchema.ChannelEditEdit200,
    {
      method: 'PATCH',
      token,
      body: { owner: ownerId },
    },
  )
})

export function transferGroupOwnership(
  token: string,
  groupId: string,
  ownerId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    transferGroupOwnershipEffect(token, groupId, ownerId),
    signal ? { signal } : undefined,
  )
}

export const deleteChannelEffect = Effect.fn('web.channels.delete')(
  function*(token: string, channelId: string, leaveSilently = false) {
    const search = new URLSearchParams({
      leave_silently: String(leaveSilently),
    })

    return yield* apiRequestEffect(
      `/channels/${channelId}?${search}`,
      Schema.Void,
      {
        method: 'DELETE',
        token,
      },
    )
  },
)

export function deleteChannel(
  token: string,
  channelId: string,
  leaveSilently = false,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteChannelEffect(token, channelId, leaveSilently),
    signal ? { signal } : undefined,
  )
}

export const setChannelRolePermissionsEffect = Effect.fn(
  'web.channels.setRolePermissions',
)(function*(
  token: string,
  channelId: string,
  roleId: string,
  data: DataSetRolePermissions,
) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/permissions/${roleId}`,
    ApiSchema.PermissionsSetSetRolePermissions200,
    {
      method: 'PUT',
      token,
      body: data,
    },
  )
})

export function setChannelRolePermissions(
  token: string,
  channelId: string,
  roleId: string,
  data: DataSetRolePermissions,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    setChannelRolePermissionsEffect(token, channelId, roleId, data),
    signal ? { signal } : undefined,
  )
}

export const setChannelUserPermissionsEffect = Effect.fn(
  'web.channels.setUserPermissions',
)(function*(
  token: string,
  channelId: string,
  userId: string,
  data: DataSetUserPermissions,
) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/permissions/users/${userId}`,
    ApiSchema.PermissionsSetUserSetUserPermissions200,
    {
      method: 'PUT',
      token,
      body: data,
    },
  )
})

export function setChannelUserPermissions(
  token: string,
  channelId: string,
  userId: string,
  data: DataSetUserPermissions,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    setChannelUserPermissionsEffect(token, channelId, userId, data),
    signal ? { signal } : undefined,
  )
}

export const setDefaultChannelPermissionsEffect = Effect.fn(
  'web.channels.setDefaultPermissions',
)(function*(
  token: string,
  channelId: string,
  data: { permissions: number } | DataSetRolePermissions,
) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/permissions/default`,
    ApiSchema.PermissionsSetDefaultSetDefaultChannelPermissions200,
    {
      method: 'PUT',
      token,
      body: data,
    },
  )
})

export function setDefaultChannelPermissions(
  token: string,
  channelId: string,
  data: { permissions: number } | DataSetRolePermissions,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    setDefaultChannelPermissionsEffect(token, channelId, data),
    signal ? { signal } : undefined,
  )
}

export const fetchChannelWebhooksEffect = Effect.fn(
  'web.channels.fetchWebhooks',
)(function*(token: string, channelId: string) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/webhooks`,
    ApiSchema.WebhookFetchAllFetchWebhooks200,
    { token },
  )
})

export function fetchChannelWebhooks(
  token: string,
  channelId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchChannelWebhooksEffect(token, channelId),
    signal ? { signal } : undefined,
  )
}

export const createChannelWebhookEffect = Effect.fn(
  'web.channels.createWebhook',
)(function*(
  token: string,
  channelId: string,
  data: CreateWebhookBody,
) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/webhooks`,
    ApiSchema.WebhookCreateCreateWebhook200,
    {
      method: 'POST',
      token,
      body: data,
    },
  )
})

export function createChannelWebhook(
  token: string,
  channelId: string,
  data: CreateWebhookBody,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createChannelWebhookEffect(token, channelId, data),
    signal ? { signal } : undefined,
  )
}

export const editWebhookEffect = Effect.fn('web.channels.editWebhook')(
  function*(token: string, webhookId: string, data: DataEditWebhook) {
    return yield* apiRequestEffect(
      `/webhooks/${webhookId}`,
      ApiSchema.WebhookEditWebhookEdit200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function editWebhook(
  token: string,
  webhookId: string,
  data: DataEditWebhook,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    editWebhookEffect(token, webhookId, data),
    signal ? { signal } : undefined,
  )
}

export const deleteWebhookEffect = Effect.fn('web.channels.deleteWebhook')(
  function*(token: string, webhookId: string) {
    return yield* apiRequestEffect(`/webhooks/${webhookId}`, Schema.Void, {
      method: 'DELETE',
      token,
    })
  },
)

export function deleteWebhook(
  token: string,
  webhookId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteWebhookEffect(token, webhookId),
    signal ? { signal } : undefined,
  )
}

export const cancelDirectMessageCallEffect = Effect.fn(
  'web.channels.cancelDirectMessageCall',
)(function*(token: string, channelId: string) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/voice/cancel`,
    Schema.Void,
    {
      method: 'PUT',
      token,
    },
  )
})

export function cancelDirectMessageCall(
  token: string,
  channelId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    cancelDirectMessageCallEffect(token, channelId),
    signal ? { signal } : undefined,
  )
}

export const declineDirectMessageCallEffect = Effect.fn(
  'web.channels.declineDirectMessageCall',
)(function*(token: string, channelId: string) {
  return yield* apiRequestEffect(
    `/channels/${channelId}/voice/decline`,
    Schema.Void,
    {
      method: 'PUT',
      token,
    },
  )
})

export function declineDirectMessageCall(
  token: string,
  channelId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    declineDirectMessageCallEffect(token, channelId),
    signal ? { signal } : undefined,
  )
}
