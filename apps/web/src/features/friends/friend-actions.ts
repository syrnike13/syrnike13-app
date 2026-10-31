import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'

import {
  acceptFriendRequestEffect,
  blockUserEffect,
  removeFriendOrRequestEffect,
  sendFriendRequestEffect,
  unblockUserEffect,
} from '@syrnike13/client/api/users-api'
import { syncStore } from '@syrnike13/client/sync/sync-store'

export type FriendActionDeps = {
  acceptFriendRequest: typeof acceptFriendRequestEffect
  removeFriendOrRequest: typeof removeFriendOrRequestEffect
  blockUser: typeof blockUserEffect
  sendFriendRequest: typeof sendFriendRequestEffect
  unblockUser: typeof unblockUserEffect
  upsertUser: (user: User) => void
}

const defaultDeps: FriendActionDeps = {
  acceptFriendRequest: acceptFriendRequestEffect,
  removeFriendOrRequest: removeFriendOrRequestEffect,
  blockUser: blockUserEffect,
  sendFriendRequest: sendFriendRequestEffect,
  unblockUser: unblockUserEffect,
  upsertUser: syncStore.upsertUser,
}

function friendRequestUsername(user: User) {
  return user.username
}

const runFriendAction = Effect.fn('friends.runAction')(
  function*(
    request: () => Effect.Effect<User, unknown>,
    deps: FriendActionDeps,
  ) {
    const action = Effect.gen(function*() {
      const updatedUser = yield* request()
      yield* Effect.try({
        try: () => {
          deps.upsertUser(updatedUser)
        },
        catch: (cause) => cause,
      })
      return updatedUser
    })

    return yield* action
  },
)

export function sendFriendRequestToUser(
  token: string,
  user: User,
  deps: FriendActionDeps = defaultDeps,
) {
  return sendFriendRequestByUsername(
    token,
    friendRequestUsername(user),
    deps,
  )
}

export function sendFriendRequestByUsername(
  token: string,
  username: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return runFriendAction(
    () => deps.sendFriendRequest(token, username),
    deps,
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
  )
}
