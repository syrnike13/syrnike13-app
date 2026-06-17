import type {
  Channel,
  InviteJoinResponse,
  InviteResponse,
  Member,
  Server,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function fetchPublicInvite(code: string) {
  return apiRequest<InviteResponse>(`/invites/${code}`)
}

export async function joinInvite(token: string, code: string) {
  return apiRequest<InviteJoinResponse>(`/invites/${code}`, {
    method: 'POST',
    token,
  })
}

export async function deleteInvite(token: string, code: string) {
  return apiRequest<void>(`/invites/${code}`, {
    method: 'DELETE',
    token,
  })
}

export type ServerInviteJoinResult = {
  type: 'Server'
  server: Server
  member: Member
  channels: Channel[]
}

export function isServerInviteJoin(
  response: InviteJoinResponse,
): response is ServerInviteJoinResult {
  return (
    typeof response === 'object' &&
    response !== null &&
    'type' in response &&
    response.type === 'Server'
  )
}
