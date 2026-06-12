export type ChannelSettingsTab = 'overview' | 'permissions'

export const CHANNEL_SETTINGS_TABS: ChannelSettingsTab[] = [
  'overview',
  'permissions',
]

export function parseChannelSettingsTab(value: unknown): ChannelSettingsTab {
  if (
    typeof value === 'string' &&
    CHANNEL_SETTINGS_TABS.includes(value as ChannelSettingsTab)
  ) {
    return value as ChannelSettingsTab
  }
  return 'overview'
}

export const CHANNEL_SETTINGS_TAB_LABELS: Record<ChannelSettingsTab, string> = {
  overview: 'Обзор',
  permissions: 'Права доступа',
}
