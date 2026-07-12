export type ServerSettingsTab =
  | 'overview'
  | 'emoji'
  | 'roles'
  | 'members'
  | 'bans'
  | 'invites'
  | 'audit'

export const SERVER_SETTINGS_TABS: ServerSettingsTab[] = [
  'overview',
  'emoji',
  'roles',
  'members',
  'bans',
  'invites',
  'audit',
]

export function parseServerSettingsTab(
  value: unknown,
): ServerSettingsTab {
  if (
    typeof value === 'string' &&
    SERVER_SETTINGS_TABS.includes(value as ServerSettingsTab)
  ) {
    return value as ServerSettingsTab
  }
  if (value === 'general') return 'overview'
  return 'overview'
}

export const SERVER_SETTINGS_TAB_LABELS: Record<ServerSettingsTab, string> = {
  overview: 'Профиль сервера',
  emoji: 'Emoji',
  roles: 'Роли',
  members: 'Участники',
  bans: 'Баны',
  invites: 'Приглашения',
  audit: 'Журнал аудита',
}
