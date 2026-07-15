import type { Channel, Member, Server } from '@syrnike13/api-types'

import type { ServerSettingsTab } from '#/components/servers/server-settings-types'
import type { ServerChannel } from '#/lib/channel-voice'
import { hasPermissionBit } from '#/lib/permission-bits'
import { ServerPermission } from '#/lib/server-permissions'
import {
  GlobalPermission,
  UserPermission,
} from './permission-bits.generated'
import { syncStore } from '#/features/sync/sync-store'

export const ChannelPermission = ServerPermission

type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>

export type ServerMenuPermissions = {
  invite: boolean
  settings: boolean
  roles: boolean
  audit: boolean
  createChannel: boolean
  leave: boolean
  copyId: boolean
}

export type ServerSettingsAccess = {
  overview: boolean
  emoji: boolean
  roles: boolean
  members: boolean
  bans: boolean
  invites: boolean
  audit: boolean
}

/**
 * The only client-side interface to current-user authorization decisions.
 * Missing snapshot scopes fail closed. Policy evaluation stays on the backend.
 */
function serverPermissionMask(server: Server | string | undefined) {
  const serverId = typeof server === 'string' ? server : server?._id
  return serverId
    ? (syncStore.getState().authorization.servers[serverId] ?? 0)
    : 0
}

function channelPermissionMask(
  channel: { _id: string } | string | undefined,
) {
  const channelId = typeof channel === 'string' ? channel : channel?._id
  return channelId
    ? (syncStore.getState().authorization.channels[channelId] ?? 0)
    : 0
}

function userPermissionMask(userId: string | undefined) {
  return userId
    ? (syncStore.getState().authorization.users[userId] ?? 0)
    : 0
}

export function canAccessAdmin() {
  return hasPermissionBit(
    syncStore.getState().authorization.global,
    GlobalPermission.AccessAdmin,
  )
}

export function canAccessUser(userId: string | undefined) {
  return hasPermissionBit(userPermissionMask(userId), UserPermission.Access)
}

export function canViewUserProfile(userId: string | undefined) {
  return hasPermissionBit(userPermissionMask(userId), UserPermission.ViewProfile)
}

export function canMessageUser(userId: string | undefined) {
  return hasPermissionBit(userPermissionMask(userId), UserPermission.SendMessage)
}

export function canInviteUser(userId: string | undefined) {
  return hasPermissionBit(userPermissionMask(userId), UserPermission.Invite)
}

function hasChannelPermission(permissions: number, permission: number) {
  return hasPermissionBit(permissions, permission)
}

function serverHas(server: Server | string | undefined, permission: number) {
  return hasChannelPermission(serverPermissionMask(server), permission)
}

function channelHas(
  channel: { _id: string } | string | undefined,
  permission: number,
) {
  return hasChannelPermission(channelPermissionMask(channel), permission)
}

export function canManageServer(server: Server | string | undefined) {
  return serverHas(server, ChannelPermission.ManageServer)
}

export function canManageServerRoles(server: Server | string | undefined) {
  return serverHas(server, ChannelPermission.ManageRole)
}

export function canManageServerPermissions(
  server: Server | string | undefined,
) {
  return serverHas(server, ChannelPermission.ManagePermissions)
}

export function canGrantServerPermission(
  server: Server | string | undefined,
  permission: number,
) {
  return serverHas(server, permission)
}

export function canGrantChannelPermission(
  channel: { _id: string } | string | undefined,
  permission: number,
) {
  return channelHas(channel, permission)
}

export function canConnectToChannel(
  channel: { _id: string } | string | undefined,
) {
  return channelHas(channel, ChannelPermission.Connect)
}

export function getMemberRank(server: Server, member: Member | undefined) {
  if (!member?.roles?.length || !server.roles) return Number.MAX_SAFE_INTEGER

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
  _userPrivileged = false,
) {
  if (!userId || !serverHas(server, ChannelPermission.AssignRoles)) return false
  if (server.owner === userId || canAccessAdmin()) return true
  return Boolean(
    roleRank > getMemberRank(server, member),
  )
}

function canModerateServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  permission: number,
  _actorPrivileged = false,
) {
  if (!actorUserId || !targetMember) return false
  if (actorUserId === targetMember._id.user) return false
  if (server.owner === targetMember._id.user) return false
  if (!serverHas(server, permission)) return false
  if (server.owner === actorUserId || canAccessAdmin()) return true
  return getMemberRank(server, targetMember) > getMemberRank(server, actorMember)
}

export function canKickServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.KickMembers,
    _actorPrivileged,
  )
}

export function canBanServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.BanMembers,
    _actorPrivileged,
  )
}

export function canTimeoutServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.TimeoutMembers,
    _actorPrivileged,
  )
}

export function canMuteServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.MuteMembers,
    _actorPrivileged,
  )
}

export function canDeafenServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.DeafenMembers,
    _actorPrivileged,
  )
}

export function canMoveServerMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  return canModerateServerMember(
    server,
    actorMember,
    actorUserId,
    targetMember,
    ChannelPermission.MoveMembers,
    _actorPrivileged,
  )
}

export function canChangeMemberNickname(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member | undefined,
  _actorPrivileged = false,
) {
  if (!actorUserId || !targetMember) return false
  if (actorUserId === targetMember._id.user) {
    return serverHas(server, ChannelPermission.ChangeNickname)
  }
  if (!serverHas(server, ChannelPermission.ManageNicknames)) return false
  if (server.owner === targetMember._id.user) return false
  if (server.owner === actorUserId || canAccessAdmin()) return true
  return getMemberRank(server, targetMember) > getMemberRank(server, actorMember)
}

export function canEditMember(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
  _actorPrivileged = false,
) {
  if (!actorUserId) return false
  if (actorUserId === targetMember._id.user) {
    return serverHas(server, ChannelPermission.ChangeNickname)
  }
  const canEdit =
    serverHas(server, ChannelPermission.AssignRoles) ||
    serverHas(server, ChannelPermission.ManageNicknames)
  if (!canEdit || server.owner === targetMember._id.user) return false
  if (server.owner === actorUserId || canAccessAdmin()) return true
  return getMemberRank(server, targetMember) > getMemberRank(server, actorMember)
}

export function canManageChannelPermissionSubject(
  server: Server,
  channel: ServerChannel,
  member: Member | undefined,
  userId: string | undefined,
  subject: { userId?: string; roleRank?: number },
  _userPrivileged = false,
) {
  if (!userId || !canManageChannelPermissions(server, channel, member, userId)) {
    return false
  }
  if (server.owner === userId || canAccessAdmin()) return true
  if (subject.userId) {
    if (subject.userId === userId) return true
    if (subject.userId === server.owner) return false
  }
  const subjectRank = subject.roleRank ?? Number.MAX_SAFE_INTEGER
  return subjectRank > getMemberRank(server, member)
}

export function canManageRole(
  server: Server,
  member: Member | undefined,
  userId: string | undefined,
  roleRank: number,
  options: { permissions?: boolean; privileged?: boolean } = {},
) {
  const required = options.permissions
    ? ChannelPermission.ManagePermissions
    : ChannelPermission.ManageRole
  if (!userId || !serverHas(server, required)) return false
  if (server.owner === userId || canAccessAdmin()) return true
  return roleRank > getMemberRank(server, member)
}

export function getServerSettingsAccess(
  server: Server,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
): ServerSettingsAccess {
  const has = (permission: number) => serverHas(server, permission)
  return {
    overview: has(ChannelPermission.ManageServer),
    emoji: has(ChannelPermission.ManageCustomisation),
    roles:
      has(ChannelPermission.ManageRole) ||
      has(ChannelPermission.ManagePermissions),
    members:
      has(ChannelPermission.KickMembers) ||
      has(ChannelPermission.BanMembers) ||
      has(ChannelPermission.TimeoutMembers) ||
      has(ChannelPermission.AssignRoles) ||
      has(ChannelPermission.ManageNicknames) ||
      has(ChannelPermission.ManageServer),
    bans: has(ChannelPermission.BanMembers),
    invites: has(ChannelPermission.ManageServer),
    audit: has(ChannelPermission.ManageServer),
  }
}

export function canOpenServerSettings(access: ServerSettingsAccess) {
  return Object.values(access).some(Boolean)
}

export function canViewServerSettingsTab(
  access: ServerSettingsAccess,
  tab: ServerSettingsTab,
) {
  return access[tab]
}

export function getServerMenuPermissions(
  server: Server,
  channels: Channel[],
  member: Member | undefined,
  userId: string | undefined,
  userPrivileged = false,
): ServerMenuPermissions {
  const access = getServerSettingsAccess(
    server,
    member,
    userId,
    userPrivileged,
  )
  return {
    invite:
      serverHas(server, ChannelPermission.ManageServer) ||
      channels.some((channel) =>
        channelHas(channel, ChannelPermission.InviteOthers),
      ),
    settings: canOpenServerSettings(access),
    roles: access.roles,
    audit: access.audit,
    createChannel: serverHas(server, ChannelPermission.ManageChannel),
    leave: Boolean(member),
    copyId: Boolean(member),
  }
}

export function canInviteToChannel(
  _server: Server,
  channel: ServerTextChannel,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return channelHas(channel, ChannelPermission.InviteOthers)
}

export function canManageServerChannels(
  server: Server,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return serverHas(server, ChannelPermission.ManageChannel)
}

export function canManageChannel(
  server: Server | undefined,
  channel: ServerChannel,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return Boolean(server && channelHas(channel, ChannelPermission.ManageChannel))
}

export function canManageChannelPermissions(
  server: Server | undefined,
  channel: ServerChannel,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return Boolean(
    server && channelHas(channel, ChannelPermission.ManagePermissions),
  )
}

export function canManageChannelMessages(
  server: Server | undefined,
  channel: ServerChannel,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return Boolean(
    server &&
      channel.channel_type === 'TextChannel' &&
      channelHas(channel, ChannelPermission.ManageMessages),
  )
}

export function canManageChannelWebhooks(
  server: Server | undefined,
  channel: ServerChannel,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return Boolean(
    server &&
      channel.channel_type === 'TextChannel' &&
      channelHas(channel, ChannelPermission.ManageWebhooks),
  )
}

export function canViewChannel(
  server: Server | undefined,
  channel: ServerTextChannel,
  _member: Member | undefined,
  _userId: string | undefined,
  _userPrivileged = false,
) {
  return Boolean(server && channelHas(channel, ChannelPermission.ViewChannel))
}
