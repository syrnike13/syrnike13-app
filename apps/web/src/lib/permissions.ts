import type { Channel, Member, Server } from '@syrnike13/api-types'

export const ChannelPermission = {
  ManageChannel: 1 << 0,
  ManageServer: 1 << 1,
  InviteOthers: 1 << 25,
  ViewChannel: 1 << 20,
  ReadMessageHistory: 1 << 21,
  Speak: 1 << 31,
  Video: 1 << 32,
  Listen: 1 << 36,
} as const

export const GRANT_ALL_SAFE = 0x000f_ffff_ffff_ffff

const ALLOW_IN_TIMEOUT =
  ChannelPermission.ViewChannel | ChannelPermission.ReadMessageHistory

type OverrideField = { a: number; d: number }

type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>

function toUnsigned(value: number): number {
  return value >>> 0
}

export function applyOverride(
  permissions: number,
  override: OverrideField | null | undefined,
): number {
  if (!override) return toUnsigned(permissions)
  const allow = toUnsigned(override.a)
  const deny = toUnsigned(override.d)
  return toUnsigned((permissions | allow) & ~deny)
}

export function hasChannelPermission(
  permissions: number,
  permission: number,
): boolean {
  return (toUnsigned(permissions) & permission) === permission
}

export function calculateServerPermissions(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
): number {
  if (!userId) return 0
  if (server.owner === userId) return GRANT_ALL_SAFE
  if (!member) return 0

  let permissions = toUnsigned(server.default_permissions)

  const roles = (member.roles ?? [])
    .map((roleId) => server.roles?.[roleId])
    .filter((role): role is NonNullable<typeof role> => Boolean(role))
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))

  for (const role of roles) {
    permissions = applyOverride(permissions, role.permissions)
  }

  if (member.timeout && new Date(member.timeout) > new Date()) {
    permissions = permissions & ALLOW_IN_TIMEOUT
  }

  if (member.can_publish === false) {
    permissions &= ~(ChannelPermission.Speak | ChannelPermission.Video)
  }

  if (member.can_receive === false) {
    permissions &= ~ChannelPermission.Listen
  }

  return permissions
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
    permissions = permissions & ALLOW_IN_TIMEOUT
  }

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
