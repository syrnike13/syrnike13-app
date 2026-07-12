import type {
  Channel,
  DataCreateInvite,
  DataModerationAction,
  Invite,
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

export async function deleteInvite(
  token: string,
  code: string,
  body: DataModerationAction = {},
) {
  return apiRequest<void>(`/invites/${code}`, {
    method: 'DELETE',
    token,
    body,
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
    response.type === 'Server' &&
    'server' in response &&
    typeof response.server === 'object' &&
    response.server !== null &&
    'member' in response &&
    typeof response.member === 'object' &&
    response.member !== null &&
    'channels' in response &&
    Array.isArray(response.channels)
  )
}
