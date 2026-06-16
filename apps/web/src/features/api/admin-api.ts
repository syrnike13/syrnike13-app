import type {
  Badge,
  DataCreateBadge,
  DataEditBadge,
  User,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function fetchAdminBadges(token: string) {
  return apiRequest<Badge[]>('/admin/badges', { token })
}

export async function createAdminBadge(token: string, data: DataCreateBadge) {
  return apiRequest<Badge>('/admin/badges', {
    method: 'POST',
    token,
    body: data,
  })
}

export async function updateAdminBadge(
  token: string,
  badgeId: string,
  data: DataEditBadge,
) {
  return apiRequest<Badge>(`/admin/badges/${badgeId}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function deleteAdminBadge(token: string, badgeId: string) {
  return apiRequest<void>(`/admin/badges/${badgeId}`, {
    method: 'DELETE',
    token,
  })
}

export async function fetchAdminUser(token: string, query: string) {
  return apiRequest<User>(`/admin/users/${encodeURIComponent(query)}`, {
    token,
  })
}

export async function fetchAdminUserBadges(token: string, userId: string) {
  return apiRequest<Badge[]>(`/admin/users/${userId}/badges`, { token })
}

export async function assignAdminUserBadge(
  token: string,
  userId: string,
  badgeId: string,
) {
  return apiRequest<Badge[]>(`/admin/users/${userId}/badges/${badgeId}`, {
    method: 'PUT',
    token,
  })
}

export async function removeAdminUserBadge(
  token: string,
  userId: string,
  badgeId: string,
) {
  return apiRequest<Badge[]>(`/admin/users/${userId}/badges/${badgeId}`, {
    method: 'DELETE',
    token,
  })
}
