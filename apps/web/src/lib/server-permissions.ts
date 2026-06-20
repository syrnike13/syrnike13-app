import {
  hasPermissionBit,
  maskPermissionBits,
  permissionAndNot,
  permissionBit,
  permissionOr,
} from '#/lib/permission-bits'

const p = permissionBit

export const ServerPermission = {
  ManageChannel: p(0),
  ManageServer: p(1),
  ManagePermissions: p(2),
  ManageRole: p(3),
  ManageCustomisation: p(4),
  KickMembers: p(6),
  BanMembers: p(7),
  TimeoutMembers: p(8),
  AssignRoles: p(9),
  ChangeNickname: p(10),
  ManageNicknames: p(11),
  ChangeAvatar: p(12),
  RemoveAvatars: p(13),
  ViewChannel: p(20),
  ReadMessageHistory: p(21),
  SendMessage: p(22),
  ManageMessages: p(23),
  ManageWebhooks: p(24),
  InviteOthers: p(25),
  SendEmbeds: p(26),
  UploadFiles: p(27),
  Masquerade: p(28),
  React: p(29),
  Connect: p(30),
  Speak: p(31),
  Video: p(32),
  MuteMembers: p(33),
  DeafenMembers: p(34),
  MoveMembers: p(35),
  Listen: p(36),
  MentionEveryone: p(37),
  MentionRoles: p(38),
  BypassSlowmode: p(39),
} as const

export type ServerPermissionName = keyof typeof ServerPermission

export type PermissionOverrideField = { a: number; d: number }

export type PermissionOverride = { allow: number; deny: number }

export type PermissionTriState = 'neutral' | 'allow' | 'deny'

export type PermissionDefinition = {
  flag: number
  label: string
}

export type PermissionGroup = {
  title: string
  permissions: PermissionDefinition[]
}

export const SERVER_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: 'Общие права сервера',
    permissions: [
      { flag: ServerPermission.ManageChannel, label: 'Управление каналами' },
      { flag: ServerPermission.ManageServer, label: 'Управление сервером' },
      { flag: ServerPermission.ManagePermissions, label: 'Управление правами' },
      { flag: ServerPermission.ManageRole, label: 'Управление ролями' },
      {
        flag: ServerPermission.ManageCustomisation,
        label: 'Управление оформлением',
      },
    ],
  },
  {
    title: 'Участники',
    permissions: [
      { flag: ServerPermission.KickMembers, label: 'Исключать участников' },
      { flag: ServerPermission.BanMembers, label: 'Банить участников' },
      { flag: ServerPermission.TimeoutMembers, label: 'Тайм-аут участников' },
      { flag: ServerPermission.AssignRoles, label: 'Назначать роли' },
      { flag: ServerPermission.ChangeNickname, label: 'Менять свой ник' },
      { flag: ServerPermission.ManageNicknames, label: 'Управлять никами' },
      { flag: ServerPermission.ChangeAvatar, label: 'Менять свой аватар' },
      { flag: ServerPermission.RemoveAvatars, label: 'Удалять аватары' },
    ],
  },
  {
    title: 'Текстовые каналы',
    permissions: [
      { flag: ServerPermission.ViewChannel, label: 'Просмотр каналов' },
      {
        flag: ServerPermission.ReadMessageHistory,
        label: 'Читать историю сообщений',
      },
      { flag: ServerPermission.SendMessage, label: 'Отправлять сообщения' },
      { flag: ServerPermission.ManageMessages, label: 'Управлять сообщениями' },
      { flag: ServerPermission.ManageWebhooks, label: 'Управлять вебхуками' },
      { flag: ServerPermission.InviteOthers, label: 'Приглашать людей' },
      { flag: ServerPermission.SendEmbeds, label: 'Встраивать контент' },
      { flag: ServerPermission.UploadFiles, label: 'Прикреплять файлы' },
      { flag: ServerPermission.Masquerade, label: 'Маскировка' },
      { flag: ServerPermission.React, label: 'Добавлять реакции' },
      { flag: ServerPermission.MentionEveryone, label: 'Упоминать @everyone' },
      { flag: ServerPermission.MentionRoles, label: 'Упоминать роли' },
      { flag: ServerPermission.BypassSlowmode, label: 'Обходить slowmode' },
    ],
  },
  {
    title: 'Голосовые каналы',
    permissions: [
      { flag: ServerPermission.Connect, label: 'Подключаться' },
      { flag: ServerPermission.Speak, label: 'Говорить' },
      { flag: ServerPermission.Video, label: 'Видео' },
      { flag: ServerPermission.Listen, label: 'Слушать' },
      { flag: ServerPermission.MuteMembers, label: 'Мьютить участников' },
      { flag: ServerPermission.DeafenMembers, label: 'Отключать звук' },
      { flag: ServerPermission.MoveMembers, label: 'Перемещать участников' },
    ],
  },
]

export const ALL_SERVER_PERMISSION_FLAGS = SERVER_PERMISSION_GROUPS.flatMap(
  (group) => group.permissions.map((permission) => permission.flag),
)

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
  return [...roleIdsHighestFirst].reverse()
}
