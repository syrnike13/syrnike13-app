import type {
  Channel,
  DataEditUser,
  DataSendFriendRequest,
  User,
  UserProfile,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function updateCurrentUser(token: string, data: DataEditUser) {
  return apiRequest<User>('/users/@me', {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function openDirectMessage(token: string, userId: string) {
  return apiRequest<Channel>(`/users/${userId}/dm`, { token })
}

export async function fetchUser(token: string, userId: string) {
  return apiRequest<User>(`/users/${userId}`, { token })
}

export async function fetchUserProfile(token: string, userId: string) {
  return apiRequest<UserProfile>(`/users/${userId}/profile`, { token })
}

export async function sendFriendRequest(token: string, username: string) {
  const body: DataSendFriendRequest = { username }
  return apiRequest<User>('/users/friend', {
    method: 'POST',
    token,
    body,
  })
}

export async function acceptFriendRequest(token: string, userId: string) {
  return apiRequest<User>(`/users/${userId}/friend`, {
    method: 'PUT',
    token,
  })
}

export async function removeFriendOrRequest(token: string, userId: string) {
  return apiRequest<User>(`/users/${userId}/friend`, {
    method: 'DELETE',
    token,
  })
}

export async function blockUser(token: string, userId: string) {
  return apiRequest<User>(`/users/${userId}/block`, {
    method: 'PUT',
    token,
  })
}

export async function unblockUser(token: string, userId: string) {
  return apiRequest<User>(`/users/${userId}/block`, {
    method: 'DELETE',
    token,
  })
}
