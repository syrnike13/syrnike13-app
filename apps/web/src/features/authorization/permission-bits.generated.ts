// Generated from services/backend/crates/core/permissions/src/models/{channel,global,user}.rs.
// Run `pnpm permissions:generate` after changing the Rust permission enums.
import { permissionBit } from '#/lib/permission-bits'

export const ServerPermission = {
  ManageChannel: permissionBit(0),
  ManageServer: permissionBit(1),
  ManagePermissions: permissionBit(2),
  ManageRole: permissionBit(3),
  ManageCustomisation: permissionBit(4),
  KickMembers: permissionBit(6),
  BanMembers: permissionBit(7),
  TimeoutMembers: permissionBit(8),
  AssignRoles: permissionBit(9),
  ChangeNickname: permissionBit(10),
  ManageNicknames: permissionBit(11),
  ChangeAvatar: permissionBit(12),
  RemoveAvatars: permissionBit(13),
  ViewChannel: permissionBit(20),
  ReadMessageHistory: permissionBit(21),
  SendMessage: permissionBit(22),
  ManageMessages: permissionBit(23),
  ManageWebhooks: permissionBit(24),
  InviteOthers: permissionBit(25),
  SendEmbeds: permissionBit(26),
  UploadFiles: permissionBit(27),
  Masquerade: permissionBit(28),
  React: permissionBit(29),
  BypassSlowmode: permissionBit(39),
  Connect: permissionBit(30),
  Speak: permissionBit(31),
  Video: permissionBit(32),
  MuteMembers: permissionBit(33),
  DeafenMembers: permissionBit(34),
  MoveMembers: permissionBit(35),
  Listen: permissionBit(36),
  MentionEveryone: permissionBit(37),
  MentionRoles: permissionBit(38),
} as const

export const GlobalPermission = {
  AccessAdmin: permissionBit(0),
} as const

export const UserPermission = {
  Access: permissionBit(0),
  ViewProfile: permissionBit(1),
  SendMessage: permissionBit(2),
  Invite: permissionBit(3),
} as const
