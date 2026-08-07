import { Option, Schema } from 'effect'

export const ChannelSettingsTabSchema = Schema.Literals([
  'overview',
  'permissions',
  'webhooks',
])
export type ChannelSettingsTab = typeof ChannelSettingsTabSchema.Type

export const CHANNEL_SETTINGS_TABS: ChannelSettingsTab[] = [
  'overview',
  'permissions',
  'webhooks',
]

export function parseChannelSettingsTab(value: unknown): ChannelSettingsTab {
  return Option.getOrElse(
    Schema.decodeUnknownOption(ChannelSettingsTabSchema)(value),
    () => 'overview',
  )
}

export const CHANNEL_SETTINGS_TAB_LABELS: Record<ChannelSettingsTab, string> = {
  overview: 'Обзор',
  permissions: 'Права доступа',
  webhooks: 'Вебхуки',
}
