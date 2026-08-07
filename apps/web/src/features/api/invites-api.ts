import type {
  Channel,
  DataCreateInvite,
  DataModerationAction,
  Invite,
  InviteJoinResponse,
  Member,
  Server,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const fetchPublicInviteEffect = Effect.fn('web.invites.fetchPublic')(
  function*(code: string) {
    return yield* apiRequestEffect(
      `/invites/${code}`,
      ApiSchema.InviteFetchFetch200,
    )
  },
)

export function fetchPublicInvite(code: string, signal?: AbortSignal) {
  return Effect.runPromise(
    fetchPublicInviteEffect(code),
    signal ? { signal } : undefined,
  )
}

export const joinInviteEffect = Effect.fn('web.invites.join')(
  function*(token: string, code: string) {
    return yield* apiRequestEffect(
      `/invites/${code}`,
      ApiSchema.InviteJoinJoin200,
      {
        method: 'POST',
        token,
      },
    )
  },
)

export function joinInvite(
  token: string,
  code: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    joinInviteEffect(token, code),
    signal ? { signal } : undefined,
  )
}

export const createChannelInviteEffect = Effect.fn('web.invites.create')(
  function*(
    token: string,
    channelId: string,
    body: DataCreateInvite = {},
  ) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/invites`,
      ApiSchema.InviteCreateCreateInvite200,
      {
        method: 'POST',
        token,
        body,
      },
    )
  },
)

export function createChannelInvite(
  token: string,
  channelId: string,
  body: DataCreateInvite = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createChannelInviteEffect(token, channelId, body),
    signal ? { signal } : undefined,
  )
}

export const deleteInviteEffect = Effect.fn('web.invites.delete')(
  function*(
    token: string,
    code: string,
    body: DataModerationAction = {},
  ) {
    return yield* apiRequestEffect(`/invites/${code}`, Schema.Void, {
      method: 'DELETE',
      token,
      body,
    })
  },
)

export function deleteInvite(
  token: string,
  code: string,
  body: DataModerationAction = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteInviteEffect(token, code, body),
    signal ? { signal } : undefined,
  )
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
