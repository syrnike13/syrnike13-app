import type {
  DataEditUser,
  DataSendFriendRequest,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const updateCurrentUserEffect = Effect.fn('web.users.updateCurrent')(
  function*(token: string, data: DataEditUser) {
    return yield* apiRequestEffect('/users/@me', ApiSchema.EditUserEdit200, {
      method: 'PATCH',
      token,
      body: data,
    })
  },
)

export function updateCurrentUser(
  token: string,
  data: DataEditUser,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    updateCurrentUserEffect(token, data),
    signal ? { signal } : undefined,
  )
}

export const openDirectMessageEffect = Effect.fn('web.users.openDirectMessage')(
  function*(token: string, userId: string) {
    return yield* apiRequestEffect(
      `/users/${userId}/dm`,
      ApiSchema.OpenDmOpenDm200,
      { token },
    )
  },
)

export function openDirectMessage(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    openDirectMessageEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const fetchUserEffect = Effect.fn('web.users.fetch')(
  function*(token: string, userId: string) {
    return yield* apiRequestEffect(
      `/users/${userId}`,
      ApiSchema.FetchUserFetch200,
      { token },
    )
  },
)

export function fetchUser(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchUserEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const fetchUserProfileEffect = Effect.fn('web.users.fetchProfile')(
  function*(token: string, userId: string) {
    return yield* apiRequestEffect(
      `/users/${userId}/profile`,
      ApiSchema.FetchProfileProfile200,
      { token },
    )
  },
)

export function fetchUserProfile(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchUserProfileEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const sendFriendRequestEffect = Effect.fn('web.users.sendFriendRequest')(
  function*(token: string, username: string) {
    const body: DataSendFriendRequest = { username }
    return yield* apiRequestEffect(
      '/users/friend',
      ApiSchema.SendFriendRequestSendFriendRequest200,
      {
        method: 'POST',
        token,
        body,
      },
    )
  },
)

export function sendFriendRequest(
  token: string,
  username: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    sendFriendRequestEffect(token, username),
    signal ? { signal } : undefined,
  )
}

export const acceptFriendRequestEffect = Effect.fn(
  'web.users.acceptFriendRequest',
)(function*(token: string, userId: string) {
  return yield* apiRequestEffect(
    `/users/${userId}/friend`,
    ApiSchema.AddFriendAdd200,
    {
      method: 'PUT',
      token,
    },
  )
})

export function acceptFriendRequest(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    acceptFriendRequestEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const removeFriendOrRequestEffect = Effect.fn(
  'web.users.removeFriendOrRequest',
)(function*(token: string, userId: string) {
  return yield* apiRequestEffect(
    `/users/${userId}/friend`,
    ApiSchema.RemoveFriendRemove200,
    {
      method: 'DELETE',
      token,
    },
  )
})

export function removeFriendOrRequest(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    removeFriendOrRequestEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const blockUserEffect = Effect.fn('web.users.block')(
  function*(token: string, userId: string) {
    return yield* apiRequestEffect(
      `/users/${userId}/block`,
      ApiSchema.BlockUserBlock200,
      {
        method: 'PUT',
        token,
      },
    )
  },
)

export function blockUser(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    blockUserEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const unblockUserEffect = Effect.fn('web.users.unblock')(
  function*(token: string, userId: string) {
    return yield* apiRequestEffect(
      `/users/${userId}/block`,
      ApiSchema.UnblockUserUnblock200,
      {
        method: 'DELETE',
        token,
      },
    )
  },
)

export function unblockUser(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    unblockUserEffect(token, userId),
    signal ? { signal } : undefined,
  )
}
