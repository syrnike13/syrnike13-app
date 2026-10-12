import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'

import {
  acceptFriendRequestEffect,
  blockUserEffect,
  removeFriendOrRequestEffect,
  sendFriendRequestEffect,
  unblockUserEffect,
} from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'

export type FriendActionDeps = {
  acceptFriendRequest: typeof acceptFriendRequestEffect
  removeFriendOrRequest: typeof removeFriendOrRequestEffect
  blockUser: typeof blockUserEffect
  sendFriendRequest: typeof sendFriendRequestEffect
  unblockUser: typeof unblockUserEffect
  upsertUser: (user: User) => void
  toastSuccess: (message: string) => void
  toastError: (message: string) => void
}

const defaultDeps: FriendActionDeps = {
  acceptFriendRequest: acceptFriendRequestEffect,
  removeFriendOrRequest: removeFriendOrRequestEffect,
  blockUser: blockUserEffect,
  sendFriendRequest: sendFriendRequestEffect,
  unblockUser: unblockUserEffect,
  upsertUser: syncStore.upsertUser,
  toastSuccess: toast.success,
  toastError: toast.error,
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function friendRequestUsername(user: User) {
  return `${user.username}#${user.discriminator}`
}

const runFriendAction = Effect.fn('friends.runAction')(
  function*(
    request: () => Effect.Effect<User, unknown>,
    deps: FriendActionDeps,
    successMessage: string,
    failureMessage: string,
  ) {
    const action = Effect.gen(function*() {
      const updatedUser = yield* request()
      yield* Effect.try({
        try: () => {
          deps.upsertUser(updatedUser)
          deps.toastSuccess(successMessage)
        },
        catch: (cause) => cause,
      })
      return updatedUser
    })

    return yield* action.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          deps.toastError(errorMessage(error, failureMessage))
        }),
      ),
    )
  },
)

export function sendFriendRequestToUser(
  token: string,
  user: User,
  deps: FriendActionDeps = defaultDeps,
) {
  return sendFriendRequestByUsername(token, friendRequestUsername(user), deps)
}

export function sendFriendRequestByUsername(
  token: string,
  username: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.sendFriendRequest(token, username),
    deps,
    'Заявка отправлена',
    'Не удалось отправить заявку',
  )
}

export function acceptIncomingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.acceptFriendRequest(token, userId),
    deps,
    'Заявка принята',
    'Не удалось принять заявку',
  )
}

export function declineIncomingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.removeFriendOrRequest(token, userId),
    deps,
    'Заявка отклонена',
    'Не удалось отклонить заявку',
  )
}

export function cancelOutgoingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.removeFriendOrRequest(token, userId),
    deps,
    'Заявка отменена',
    'Не удалось отменить заявку',
  )
}

export function removeFriend(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.removeFriendOrRequest(token, userId),
    deps,
    'Пользователь удалён из друзей',
    'Не удалось удалить из друзей',
  )
}

export function blockIncomingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return blockUserRelationship(token, userId, deps)
}

export function blockUserRelationship(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.blockUser(token, userId),
    deps,
    'Пользователь заблокирован',
    'Не удалось заблокировать',
  )
}

export function unblockBlockedUser(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.unblockUser(token, userId),
    deps,
    'Пользователь разблокирован',
    'Не удалось разблокировать',
  )
}
