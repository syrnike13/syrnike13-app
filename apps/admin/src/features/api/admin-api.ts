import type {
  Badge,
  DataCreateBadge,
  DataEditBadge,
  User,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'
import { config } from '#/lib/config'

export type DiagnosticReportStatus = 'new' | 'investigating' | 'resolved'

export type DiagnosticReport = {
  id: string
  user_id: string
  created_at: number
  expires_at: number
  source: string
  release_channel: string
  app_version: string
  platform: string
  area: string
  severity: string
  trigger_code: string
  description: string
  size_bytes: number
  sha256: string
  status: DiagnosticReportStatus
  notes: string
}

export type DiagnosticReportFilters = {
  before?: string
  user_id?: string
  source?: string
  release_channel?: string
  area?: string
  trigger_code?: string
  status?: DiagnosticReportStatus
  limit?: string
}

export async function fetchAdminDiagnosticReports(
  token: string,
  filters: DiagnosticReportFilters = {},
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) search.set(key, value)
  }
  const query = search.size > 0 ? `?${search}` : ''
  return apiRequest<DiagnosticReport[]>(`/admin/diagnostics${query}`, { token })
}

export async function fetchAdminDiagnosticReport(token: string, id: string) {
  return apiRequest<DiagnosticReport>(`/admin/diagnostics/${encodeURIComponent(id)}`, {
    token,
  })
}

export async function updateAdminDiagnosticReport(
  token: string,
  id: string,
  data: { status: DiagnosticReportStatus; notes: string },
) {
  return apiRequest<DiagnosticReport>(`/admin/diagnostics/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function downloadAdminDiagnosticReport(token: string, id: string) {
  const response = await fetch(
    `${config.apiUrl}/admin/diagnostics/${encodeURIComponent(id)}/download`,
    { headers: { 'X-Session-Token': token } },
  )
  if (!response.ok) throw new Error(`Не удалось скачать отчёт: HTTP ${response.status}`)
  return response.blob()
}

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
