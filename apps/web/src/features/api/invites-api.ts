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

export type InviteInactiveReason = 'revoked' | 'expired' | 'exhausted'

export function getInviteInactiveReason(
  invite: Invite,
  now = Date.now(),
): InviteInactiveReason | null {
  if (invite.revoked_at != null) return 'revoked'
  if (invite.expires_at != null && invite.expires_at <= now) return 'expired'
  if (
    invite.max_uses != null &&
    invite.max_uses > 0 &&
    invite.uses >= invite.max_uses
  ) {
    return 'exhausted'
  }
  return null
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

export type GroupInviteJoinResult = Extract<
  InviteJoinResponse,
  { type: 'Group' }
>

export function isGroupInviteJoin(
  response: InviteJoinResponse,
): response is GroupInviteJoinResult {
  return (
    typeof response === 'object' &&
    response !== null &&
    'type' in response &&
    response.type === 'Group' &&
    'channel' in response &&
    typeof response.channel === 'object' &&
    response.channel !== null &&
    'channel_type' in response.channel &&
    response.channel.channel_type === 'Group' &&
    'users' in response &&
    Array.isArray(response.users)
  )
}
