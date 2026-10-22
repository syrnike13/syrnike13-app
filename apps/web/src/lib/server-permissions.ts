import {
  hasPermissionBit,
  maskPermissionBits,
  permissionAndNot,
  permissionOr,
} from '#/lib/permission-bits'
import { ServerPermission } from '#/features/authorization/permission-bits.generated'

export { ServerPermission }

export type PermissionOverrideField = { a: number; d: number }

export type PermissionOverride = { allow: number; deny: number }

export type PermissionTriState = 'neutral' | 'allow' | 'deny'

export const PERMISSION_TRI_STATE_ORDER: PermissionTriState[] = [
  'neutral',
  'allow',
  'deny',
]

export type PermissionDefinition = {
  flag: number
  labelKey: string
}

export type PermissionGroup = {
  titleKey: string
  permissions: PermissionDefinition[]
}

export const ADMINISTRATOR_PERMISSION = {
  flag: ServerPermission.Administrator,
  labelKey: 'labels.administrator',
  hintKey: 'hints.administrator',
} as const

export const SERVER_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    titleKey: 'groups.general',
    permissions: [
      { flag: ServerPermission.ManageChannel, labelKey: 'labels.manageChannel' },
      { flag: ServerPermission.ManageServer, labelKey: 'labels.manageServer' },
      {
        flag: ServerPermission.ManagePermissions,
        labelKey: 'labels.managePermissions',
      },
      { flag: ServerPermission.ManageRole, labelKey: 'labels.manageRole' },
      {
        flag: ServerPermission.ManageCustomisation,
        labelKey: 'labels.manageCustomisation',
      },
    ],
  },
  {
    titleKey: 'groups.members',
    permissions: [
      { flag: ServerPermission.KickMembers, labelKey: 'labels.kickMembers' },
      { flag: ServerPermission.BanMembers, labelKey: 'labels.banMembers' },
      { flag: ServerPermission.TimeoutMembers, labelKey: 'labels.timeoutMembers' },
      { flag: ServerPermission.AssignRoles, labelKey: 'labels.assignRoles' },
      { flag: ServerPermission.ChangeNickname, labelKey: 'labels.changeNickname' },
      { flag: ServerPermission.ManageNicknames, labelKey: 'labels.manageNicknames' },
      { flag: ServerPermission.ChangeAvatar, labelKey: 'labels.changeAvatar' },
      { flag: ServerPermission.RemoveAvatars, labelKey: 'labels.removeAvatars' },
    ],
  },
  {
    titleKey: 'groups.textChannels',
    permissions: [
      { flag: ServerPermission.ViewChannel, labelKey: 'labels.viewChannels' },
      {
        flag: ServerPermission.ReadMessageHistory,
        labelKey: 'labels.readMessageHistory',
      },
      { flag: ServerPermission.SendMessage, labelKey: 'labels.sendMessage' },
      { flag: ServerPermission.ManageMessages, labelKey: 'labels.manageMessages' },
      { flag: ServerPermission.ManageWebhooks, labelKey: 'labels.manageWebhooks' },
      { flag: ServerPermission.InviteOthers, labelKey: 'labels.inviteOthers' },
      { flag: ServerPermission.SendEmbeds, labelKey: 'labels.sendEmbeds' },
      { flag: ServerPermission.UploadFiles, labelKey: 'labels.uploadFiles' },
      { flag: ServerPermission.Masquerade, labelKey: 'labels.masquerade' },
      { flag: ServerPermission.React, labelKey: 'labels.react' },
      { flag: ServerPermission.MentionEveryone, labelKey: 'labels.mentionEveryone' },
      { flag: ServerPermission.MentionRoles, labelKey: 'labels.mentionRoles' },
      { flag: ServerPermission.BypassSlowmode, labelKey: 'labels.bypassSlowmode' },
    ],
  },
  {
    titleKey: 'groups.voiceChannels',
    permissions: [
      { flag: ServerPermission.Connect, labelKey: 'labels.connect' },
      { flag: ServerPermission.Speak, labelKey: 'labels.speak' },
      { flag: ServerPermission.Video, labelKey: 'labels.video' },
      { flag: ServerPermission.Listen, labelKey: 'labels.listen' },
      { flag: ServerPermission.MuteMembers, labelKey: 'labels.muteMembers' },
      { flag: ServerPermission.DeafenMembers, labelKey: 'labels.deafenMembers' },
      { flag: ServerPermission.MoveMembers, labelKey: 'labels.moveMembers' },
    ],
  },
]

export const CHANNEL_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    titleKey: 'groups.channelAccess',
    permissions: [
      { flag: ServerPermission.ViewChannel, labelKey: 'labels.viewThisChannel' },
    ],
  },
  ...SERVER_PERMISSION_GROUPS.map((group) => ({
    ...group,
    permissions: group.permissions.filter(
      (permission) => permission.flag !== ServerPermission.ViewChannel,
    ),
  })).filter((group) => group.permissions.length > 0),
]

export function getPermissionTriState(
  override: PermissionOverrideField | null | undefined,
  flag: number,
): PermissionTriState {
  const allow = maskPermissionBits(override?.a ?? 0)
  const deny = maskPermissionBits(override?.d ?? 0)
  if (hasPermissionBit(deny, flag)) return 'deny'
  if (hasPermissionBit(allow, flag)) return 'allow'
  return 'neutral'
}

export function setPermissionTriState(
  override: PermissionOverrideField,
  flag: number,
  state: PermissionTriState,
): PermissionOverrideField {
  const bit = maskPermissionBits(flag)
  let allow = maskPermissionBits(override.a)
  let deny = maskPermissionBits(override.d)
  allow = permissionAndNot(allow, bit)
  deny = permissionAndNot(deny, bit)
  if (state === 'allow') allow = permissionOr(allow, bit)
  if (state === 'deny') deny = permissionOr(deny, bit)
  return { a: allow, d: deny }
}

export function getAllowedPermissionTriStates(
  baseline: PermissionOverrideField | null | undefined,
  actorHasPermission: boolean,
  flag: number,
): PermissionTriState[] {
  if (actorHasPermission) {
    return PERMISSION_TRI_STATE_ORDER
  }

  const baselineState = getPermissionTriState(baseline, flag)
  if (baselineState === 'deny') {
    return ['deny']
  }

  if (baselineState === 'neutral') {
    return ['neutral', 'deny']
  }

  return PERMISSION_TRI_STATE_ORDER
}

export function overrideFieldToApi(
  override: PermissionOverrideField,
): PermissionOverride {
  return {
    allow: maskPermissionBits(override.a),
    deny: maskPermissionBits(override.d),
  }
}

export function overrideFieldFromRole(
  override: PermissionOverrideField | null | undefined,
): PermissionOverrideField {
  return {
    a: maskPermissionBits(override?.a ?? 0),
    d: maskPermissionBits(override?.d ?? 0),
  }
}

export function hasServerPermission(
  permissions: number,
  flag: number,
): boolean {
  return hasPermissionBit(permissions, flag)
}

export function toggleServerPermission(
  permissions: number,
  flag: number,
  enabled: boolean,
): number {
  const bit = maskPermissionBits(flag)
  return enabled
    ? permissionOr(permissions, bit)
    : permissionAndNot(permissions, bit)
}

export function normalizeRoleColour(colour: string | null | undefined): string {
  if (!colour) return '#99aab5'
  const trimmed = colour.trim()
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

export function roleColourStyle(colour: string | null | undefined) {
  if (!colour) return undefined
  return { color: normalizeRoleColour(colour) }
}

export function sortRolesByHierarchy<T extends { rank?: number | null }>(
  roles: T[],
): T[] {
  return [...roles].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
}

export function roleRanksPayload(roleIdsHighestFirst: string[]): string[] {
  return roleIdsHighestFirst
}
