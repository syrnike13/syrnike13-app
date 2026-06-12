import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import {
  acceptFriendRequest as acceptFriendRequestApi,
  blockUser as blockUserApi,
  removeFriendOrRequest as removeFriendOrRequestApi,
  sendFriendRequest as sendFriendRequestApi,
  unblockUser as unblockUserApi,
} from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'

export type FriendActionDeps = {
  acceptFriendRequest: typeof acceptFriendRequestApi
  removeFriendOrRequest: typeof removeFriendOrRequestApi
  blockUser: typeof blockUserApi
  sendFriendRequest: typeof sendFriendRequestApi
  unblockUser: typeof unblockUserApi
  upsertUser: (user: User) => void
  toastSuccess: (message: string) => void
  toastError: (message: string) => void
}

const defaultDeps: FriendActionDeps = {
  acceptFriendRequest: acceptFriendRequestApi,
  removeFriendOrRequest: removeFriendOrRequestApi,
  blockUser: blockUserApi,
  sendFriendRequest: sendFriendRequestApi,
  unblockUser: unblockUserApi,
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

export async function sendFriendRequestToUser(
  token: string,
  user: User,
  deps: FriendActionDeps = defaultDeps,
) {
  return sendFriendRequestByUsername(token, friendRequestUsername(user), deps)
}

export async function sendFriendRequestByUsername(
  token: string,
  username: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const updatedUser = await deps.sendFriendRequest(token, username)
    deps.upsertUser(updatedUser)
    deps.toastSuccess('Заявка отправлена')
    return updatedUser
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось отправить заявку'))
    throw error
  }
}

export async function acceptIncomingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const user = await deps.acceptFriendRequest(token, userId)
    deps.upsertUser(user)
    deps.toastSuccess('Заявка принята')
    return user
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось принять заявку'))
    throw error
  }
}

export async function declineIncomingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const user = await deps.removeFriendOrRequest(token, userId)
    deps.upsertUser(user)
    deps.toastSuccess('Заявка отклонена')
    return user
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось отклонить заявку'))
    throw error
  }
}

export async function cancelOutgoingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const user = await deps.removeFriendOrRequest(token, userId)
    deps.upsertUser(user)
    deps.toastSuccess('Заявка отменена')
    return user
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось отменить заявку'))
    throw error
  }
}

export async function removeFriend(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const user = await deps.removeFriendOrRequest(token, userId)
    deps.upsertUser(user)
    deps.toastSuccess('Пользователь удалён из друзей')
    return user
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось удалить из друзей'))
    throw error
  }
}

export async function blockIncomingFriendRequest(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  return blockUserRelationship(token, userId, deps)
}

export async function blockUserRelationship(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const user = await deps.blockUser(token, userId)
    deps.upsertUser(user)
    deps.toastSuccess('Пользователь заблокирован')
    return user
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось заблокировать'))
    throw error
  }
}

export async function unblockBlockedUser(
  token: string,
  userId: string,
  deps: FriendActionDeps = defaultDeps,
) {
  try {
    const user = await deps.unblockUser(token, userId)
    deps.upsertUser(user)
    deps.toastSuccess('Пользователь разблокирован')
    return user
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось разблокировать'))
    throw error
  }
}
