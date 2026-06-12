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

export const ChannelPermission = ServerPermission

export const GRANT_ALL_SAFE = 0x000f_ffff_ffff_ffff

const ALLOW_IN_TIMEOUT = permissionOr(
  ChannelPermission.ViewChannel,
  ChannelPermission.ReadMessageHistory,
)

type OverrideField = { a: number; d: number }

type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>

type ServerScopedChannel = Extract<
  Channel,
  { channel_type: 'TextChannel' | 'VoiceChannel' }
>

function clampMemberVoicePermissions(permissions: number, member: Member) {
  let next = permissions
  if (member.can_publish === false) {
    next = permissionAndNot(
      next,
      permissionOr(ChannelPermission.Speak, ChannelPermission.Video),
    )
  }

  if (member.can_receive === false) {
    next = permissionAndNot(next, ChannelPermission.Listen)
  }

  return next
}

export function applyOverride(
  permissions: number,
  override: OverrideField | null | undefined,
): number {
  if (!override) return maskPermissionBits(permissions)
  const allow = maskPermissionBits(override.a)
  const deny = maskPermissionBits(override.d)
  return permissionAnd(permissionOr(permissions, allow), permissionNot(deny))
}

export function hasChannelPermission(
  permissions: number,
  permission: number,
): boolean {
  return hasPermissionBit(permissions, permission)
}

export function calculateServerPermissions(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
): number {
  if (!userId) return 0
  if (server.owner === userId) return GRANT_ALL_SAFE
  if (!member) return 0

  let permissions = maskPermissionBits(server.default_permissions)

  const roles = (member.roles ?? [])
    .map((roleId) => server.roles?.[roleId])
    .filter((role): role is NonNullable<typeof role> => Boolean(role))
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))

  for (const role of roles) {
    permissions = applyOverride(permissions, role.permissions)
  }

  if (member.timeout && new Date(member.timeout) > new Date()) {
    permissions = permissionAnd(permissions, ALLOW_IN_TIMEOUT)
  }

  return clampMemberVoicePermissions(permissions, member)
}

export function calculateChannelPermissions(
  server: Server,
  channel: ServerTextChannel,
  member: Member | undefined,
  userId: string | undefined,
): number {
  if (!userId) return 0
  if (server.owner === userId) return GRANT_ALL_SAFE
  if (!member) return 0

  let permissions = calculateServerPermissions(server, member, userId)
  permissions = applyOverride(permissions, channel.default_permissions)

  if (channel.role_permissions && server.roles) {
    const roleOverrides = (member.roles ?? [])
      .filter((roleId) => channel.role_permissions?.[roleId])
      .map((roleId) => ({
        rank: server.roles?.[roleId]?.rank ?? 0,
        override: channel.role_permissions![roleId]!,
      }))
      .sort((a, b) => b.rank - a.rank)

    for (const { override } of roleOverrides) {
      permissions = applyOverride(permissions, override)
    }
  }

  if (member.timeout && new Date(member.timeout) > new Date()) {
    permissions = permissionAnd(permissions, ALLOW_IN_TIMEOUT)
  }

  permissions = clampMemberVoicePermissions(permissions, member)

  if (!hasChannelPermission(permissions, ChannelPermission.ViewChannel)) {
    return 0
  }

  return permissions
}

export type ServerMenuPermissions = {
  invite: boolean
  settings: boolean
  createChannel: boolean
  leave: boolean
  copyId: boolean
}

export function getMemberRank(
  server: Server,
  member: Member | undefined,
): number {
  if (!member?.roles?.length || !server.roles) {
    return Number.MAX_SAFE_INTEGER
  }

  let value = Number.MAX_SAFE_INTEGER
  for (const roleId of member.roles) {
    const rank = server.roles[roleId]?.rank ?? Number.MAX_SAFE_INTEGER
    if (rank < value) value = rank
  }
  return value
}

export function canAssignRole(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
  roleRank: number,
): boolean {
  if (!userId) return false
  if (server.owner === userId) return true

  const serverPermissions = calculateServerPermissions(server, member, userId)
  if (!hasChannelPermission(serverPermissions, ChannelPermission.AssignRoles)) {
    return false
  }

  return roleRank > getMemberRank(server, member)
}

function canModerateServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  permission: number,
): boolean {
  if (!actorUserId || !targetMember) return false
  if (actorUserId === targetMember._id.user) return false
  if (server.owner === targetMember._id.user) return false
  if (server.owner === actorUserId) return true

  const serverPermissions = calculateServerPermissions(
    server,
    actorMember,
    actorUserId,
  )
  if (!hasChannelPermission(serverPermissions, permission)) {
    return false
  }

  return getMemberRank(server, targetMember) > getMemberRank(server, actorMember)
}

export function canKickServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
): boolean {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.KickMembers,
  )
}

export function canBanServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
): boolean {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.BanMembers,
  )
}

export function canEditMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
): boolean {
  if (!actorUserId) return false
  if (actorUserId === targetMember._id.user) return true
  if (server.owner === actorUserId) return true

  const serverPermissions = calculateServerPermissions(
    server,
    actorMember,
    actorUserId,
  )
  if (!hasChannelPermission(serverPermissions, ChannelPermission.AssignRoles)) {
    return false
  }

  return (
    getMemberRank(server, targetMember) > getMemberRank(server, actorMember)
  )
}

export function canManageRole(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
  roleRank: number,
  options: { permissions?: boolean } = {},
): boolean {
  if (!userId) return false
  if (server.owner === userId) return true

  const serverPermissions = calculateServerPermissions(server, member, userId)
  const requiredPermission = options.permissions
    ? ChannelPermission.ManagePermissions
    : ChannelPermission.ManageRole

  if (!hasChannelPermission(serverPermissions, requiredPermission)) {
    return false
  }

  return roleRank > getMemberRank(server, member)
}

export function getServerMenuPermissions(
  server: Server,
  channels: Channel[],
  member: Member | undefined,
  userId: string | undefined,
): ServerMenuPermissions {
  const serverPermissions = calculateServerPermissions(server, member, userId)
  const canManageServer = hasChannelPermission(
    serverPermissions,
    ChannelPermission.ManageServer,
  )
  const canInvite =
    canManageServer ||
    channels.some(
      (channel) =>
        channel.channel_type === 'TextChannel' &&
        hasChannelPermission(
          calculateChannelPermissions(server, channel, member, userId),
          ChannelPermission.InviteOthers,
        ),
    )

  return {
    invite: canInvite,
    settings: canManageServer,
    createChannel: hasChannelPermission(
      serverPermissions,
      ChannelPermission.ManageChannel,
    ),
    leave: Boolean(member),
    copyId: Boolean(member),
  }
}

export function canInviteToChannel(
  server: Server,
  channel: ServerTextChannel,
  member: Member | undefined,
  userId: string | undefined,
): boolean {
  return hasChannelPermission(
    calculateChannelPermissions(server, channel, member, userId),
    ChannelPermission.InviteOthers,
  )
}

export function canManageServerChannels(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
): boolean {
  if (!userId) return false
  if (server.owner === userId) return true

  const serverPermissions = calculateServerPermissions(server, member, userId)
  return hasChannelPermission(
    serverPermissions,
    ChannelPermission.ManageChannel,
  )
}

export function canManageChannel(
  server: Server | undefined,
  channel: ServerScopedChannel,
  member: Member | undefined,
  userId: string | undefined,
): boolean {
  if (!server || !userId) return false

  return hasChannelPermission(
    calculateChannelPermissions(
      server,
      channel as ServerTextChannel,
      member,
      userId,
    ),
    ChannelPermission.ManageChannel,
  )
}
