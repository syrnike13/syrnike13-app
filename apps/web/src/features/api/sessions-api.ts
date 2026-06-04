import type { SessionInfo } from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function fetchSessions(token: string) {
  return apiRequest<SessionInfo[]>('/auth/session/all', { token })
}

export async function deleteSession(token: string, sessionId: string) {
  return apiRequest<void>(`/auth/session/${sessionId}`, {
    method: 'DELETE',
    token,
  })
}

export async function revokeOtherSessions(token: string) {
  return apiRequest<void>('/auth/session/all', {
    method: 'DELETE',
    token,
    body: { revoke_self: false },
  })
}
