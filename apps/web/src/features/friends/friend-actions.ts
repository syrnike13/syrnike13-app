import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'
import type { Translator } from '@syrnike13/ui/i18n'

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
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return sendFriendRequestByUsername(
    token,
    friendRequestUsername(user),
    t,
    deps,
  )
}

export function sendFriendRequestByUsername(
  token: string,
  username: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.sendFriendRequest(token, username),
    deps,
    t('requestSent'),
    t('requestSendError'),
  )
}

export function acceptIncomingFriendRequest(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.acceptFriendRequest(token, userId),
    deps,
    t('requestAccepted'),
    t('requestAcceptError'),
  )
}

export function declineIncomingFriendRequest(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.removeFriendOrRequest(token, userId),
    deps,
    t('requestDeclined'),
    t('requestDeclineError'),
  )
}

export function cancelOutgoingFriendRequest(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.removeFriendOrRequest(token, userId),
    deps,
    t('requestCancelled'),
    t('requestCancelError'),
  )
}

export function removeFriend(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.removeFriendOrRequest(token, userId),
    deps,
    t('friendRemoved'),
    t('friendRemoveError'),
  )
}

export function blockIncomingFriendRequest(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return blockUserRelationship(token, userId, t, deps)
}

export function blockUserRelationship(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.blockUser(token, userId),
    deps,
    t('userBlocked'),
    t('userBlockError'),
  )
}

export function unblockBlockedUser(
  token: string,
  userId: string,
  t: Translator,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.unblockUser(token, userId),
    deps,
    t('userUnblocked'),
    t('userUnblockError'),
  )
}
