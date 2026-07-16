import type { Channel, Member, Server } from '@syrnike13/api-types'

import {
  hasPermissionBit,
  maskPermissionBits,
  permissionAnd,
  permissionAndNot,
  permissionNot,
  permissionOr,
} from '#/lib/permission-bits'
import { ServerPermission } from '#/lib/server-permissions'
import type { ServerChannel } from '#/lib/channel-voice'

type OverrideField = { a: number; d: number }
type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>
type UserPermissionScopedChannel = ServerChannel & {
  user_permissions?: Record<string, OverrideField>
}
const GRANT_ALL_SAFE = 0x000f_ffff_ffff_ffff
const ALLOW_IN_TIMEOUT = permissionOr(
  ServerPermission.ViewChannel,
  ServerPermission.ReadMessageHistory,
)

/** Hypothetical override evaluation for permission editors and restriction badges. */
export function applyPermissionDraftOverride(
  permissions: number,
  override: OverrideField | null | undefined,
) {
  if (!override) return maskPermissionBits(permissions)
  return permissionAnd(
    permissionOr(permissions, maskPermissionBits(override.a)),
    permissionNot(maskPermissionBits(override.d)),
  )
}

function applyRoleDraftOverrides(
  permissions: number,
  overrides: OverrideField[],
) {
  let allow = 0
  let deny = 0
  for (const override of overrides) {
    allow = permissionOr(allow, override.a)
    deny = permissionOr(deny, override.d)
  }
  return permissionOr(permissionAndNot(permissions, deny), allow)
}

function clampMemberVoiceDraft(permissions: number, member: Member) {
  let next = permissions
  if (member.can_publish === false) {
    next = permissionAndNot(
      next,
      permissionOr(ServerPermission.Speak, ServerPermission.Video),
    )
  }
  if (member.can_receive === false) {
    next = permissionAndNot(next, ServerPermission.Listen)
  }
  return next
}

export function serverPermissionDraft(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
) {
  if (!userId) return 0
  if (server.owner === userId) return GRANT_ALL_SAFE
  if (!member) return 0

  let permissions = maskPermissionBits(server.default_permissions)
  const roles = (member.roles ?? [])
    .map((roleId) => server.roles?.[roleId])
    .filter((role): role is NonNullable<typeof role> => Boolean(role))
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
  for (const role of roles) {
    permissions = applyPermissionDraftOverride(permissions, role.permissions)
  }
  if (member.timeout && new Date(member.timeout) > new Date()) {
    permissions = permissionAnd(permissions, ALLOW_IN_TIMEOUT)
  }
  return clampMemberVoiceDraft(permissions, member)
}

export function channelPermissionDraft(
  server: Server,
  channel: ServerChannel,
  member: Member | undefined,
  userId: string | undefined,
) {
  if (!userId) return 0
  if (server.owner === userId) return GRANT_ALL_SAFE
  if (!member) return 0

  let permissions = applyPermissionDraftOverride(
    serverPermissionDraft(server, member, userId),
    channel.default_permissions,
  )
  const roleOverrides = (member.roles ?? [])
    .filter((roleId) => channel.role_permissions?.[roleId] && server.roles?.[roleId])
    .map((roleId) => channel.role_permissions![roleId]!)
  permissions = applyRoleDraftOverrides(permissions, roleOverrides)
  permissions = applyPermissionDraftOverride(
    permissions,
    (channel as UserPermissionScopedChannel).user_permissions?.[userId],
  )
  if (member.timeout && new Date(member.timeout) > new Date()) {
    permissions = permissionAnd(permissions, ALLOW_IN_TIMEOUT)
  }
  permissions = clampMemberVoiceDraft(permissions, member)
  return hasPermissionBit(permissions, ServerPermission.ViewChannel)
    ? permissions
    : 0
}

export function canViewChannelDraft(
  server: Server,
  channel: ServerTextChannel,
  member: Member | undefined,
  userId: string | undefined,
) {
  return hasPermissionBit(
    channelPermissionDraft(server, channel, member, userId),
    ServerPermission.ViewChannel,
  )
}

export function everyoneChannelPermissionDraft(
  server: Server,
  channel: ServerTextChannel,
) {
  return applyPermissionDraftOverride(
    maskPermissionBits(server.default_permissions ?? 0),
    channel.default_permissions,
  )
}

export function isChannelAccessRestricted(
  server: Server,
  channel: ServerTextChannel,
) {
  const permissions = everyoneChannelPermissionDraft(server, channel)
  if (!hasPermissionBit(permissions, ServerPermission.ViewChannel)) return true
  if (
    channel.voice != null &&
    !hasPermissionBit(permissions, ServerPermission.Connect)
  ) {
    return true
  }
  return Object.values(channel.role_permissions ?? {}).some(
    (override) => (override.a ?? 0) !== 0 || (override.d ?? 0) !== 0,
  )
}
