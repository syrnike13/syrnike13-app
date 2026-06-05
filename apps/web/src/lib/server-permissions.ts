export const ServerPermission = {
  ManageChannel: 1 << 0,
  ManageServer: 1 << 1,
  ManagePermissions: 1 << 2,
  ManageRole: 1 << 3,
  ManageCustomisation: 1 << 4,
  KickMembers: 1 << 6,
  BanMembers: 1 << 7,
  TimeoutMembers: 1 << 8,
  AssignRoles: 1 << 9,
  ChangeNickname: 1 << 10,
  ManageNicknames: 1 << 11,
  ChangeAvatar: 1 << 12,
  RemoveAvatars: 1 << 13,
  ViewChannel: 1 << 20,
  ReadMessageHistory: 1 << 21,
  SendMessage: 1 << 22,
  ManageMessages: 1 << 23,
  ManageWebhooks: 1 << 24,
  InviteOthers: 1 << 25,
  SendEmbeds: 1 << 26,
  UploadFiles: 1 << 27,
  Masquerade: 1 << 28,
  React: 1 << 29,
  Connect: 1 << 30,
  Speak: 1 << 31,
  Video: 1 << 32,
  MuteMembers: 1 << 33,
  DeafenMembers: 1 << 34,
  MoveMembers: 1 << 35,
  Listen: 1 << 36,
  MentionEveryone: 1 << 37,
  MentionRoles: 1 << 38,
  BypassSlowmode: 1 << 39,
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

function toUnsigned(value: number): number {
  return value >>> 0
}

export function getPermissionTriState(
  override: PermissionOverrideField | null | undefined,
  flag: number,
): PermissionTriState {
  const allow = toUnsigned(override?.a ?? 0)
  const deny = toUnsigned(override?.d ?? 0)
  const bit = toUnsigned(flag)
  if ((deny & bit) === bit) return 'deny'
  if ((allow & bit) === bit) return 'allow'
  return 'neutral'
}

export function setPermissionTriState(
  override: PermissionOverrideField,
  flag: number,
  state: PermissionTriState,
): PermissionOverrideField {
  const bit = toUnsigned(flag)
  let allow = toUnsigned(override.a)
  let deny = toUnsigned(override.d)
  allow &= ~bit
  deny &= ~bit
  if (state === 'allow') allow |= bit
  if (state === 'deny') deny |= bit
  return { a: allow, d: deny }
}

export function overrideFieldToApi(
  override: PermissionOverrideField,
): PermissionOverride {
  return { allow: toUnsigned(override.a), deny: toUnsigned(override.d) }
}

export function overrideFieldFromRole(
  override: PermissionOverrideField | null | undefined,
): PermissionOverrideField {
  return {
    a: toUnsigned(override?.a ?? 0),
    d: toUnsigned(override?.d ?? 0),
  }
}

export function hasServerPermission(
  permissions: number,
  flag: number,
): boolean {
  return (toUnsigned(permissions) & toUnsigned(flag)) === toUnsigned(flag)
}

export function toggleServerPermission(
  permissions: number,
  flag: number,
  enabled: boolean,
): number {
  const bit = toUnsigned(flag)
  return enabled
    ? toUnsigned(permissions | bit)
    : toUnsigned(permissions & ~bit)
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

export function sortRolesByRankDesc<T extends { rank?: number | null }>(
  roles: T[],
): T[] {
  return [...roles].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
}

export function roleRanksPayload(roleIdsHighestFirst: string[]): string[] {
  return [...roleIdsHighestFirst].reverse()
}
