import type {
  Channel,
  DataCreateInvite,
  Invite,
  InviteJoinResponse,
  InviteResponse,
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

export async function createChannelInvite(
  token: string,
  channelId: string,
  body: DataCreateInvite = {},
) {
  return apiRequest<Invite>(`/channels/${channelId}/invites`, {
    method: 'POST',
    token,
    body,
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
