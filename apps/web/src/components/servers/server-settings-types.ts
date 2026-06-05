export type ServerSettingsTab = 'general' | 'emoji' | 'roles' | 'members'

export const SERVER_SETTINGS_TABS: ServerSettingsTab[] = [
  'general',
  'emoji',
  'roles',
  'members',
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
  return 'general'
}

export const SERVER_SETTINGS_TAB_LABELS: Record<ServerSettingsTab, string> = {
  general: 'Профиль сервера',
  emoji: 'Emoji',
  roles: 'Роли',
  members: 'Участники',
}
