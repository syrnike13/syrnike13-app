import { Option, Schema } from 'effect'

export const ServerSettingsTabSchema = Schema.Literals([
  'overview',
  'engagement',
  'emoji',
  'roles',
  'members',
  'bans',
  'invites',
  'audit',
])
export type ServerSettingsTab = typeof ServerSettingsTabSchema.Type

export const SERVER_SETTINGS_TABS: ServerSettingsTab[] = [
  'overview',
  'engagement',
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
  if (value === 'general') return 'overview'
  return Option.getOrElse(
    Schema.decodeUnknownOption(ServerSettingsTabSchema)(value),
    () => 'overview',
  )
}

export const SERVER_SETTINGS_TAB_LABELS: Record<ServerSettingsTab, string> = {
  overview: 'Профиль сервера',
  engagement: 'Вовлеченность',
  emoji: 'Emoji',
  roles: 'Роли',
  members: 'Участники',
  bans: 'Баны',
  invites: 'Приглашения',
  audit: 'Журнал аудита',
}
