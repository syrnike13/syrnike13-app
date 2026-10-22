import { Option, Schema } from 'effect'

export const ChannelSettingsTabSchema = Schema.Literals([
  'overview',
  'permissions',
  'webhooks',
])
export type ChannelSettingsTab = typeof ChannelSettingsTabSchema.Type

export function parseChannelSettingsTab(value: unknown): ChannelSettingsTab {
  return Option.getOrElse(
    Schema.decodeUnknownOption(ChannelSettingsTabSchema)(value),
    () => 'overview',
  )
}

/** Translation keys under the `channels.tabs` namespace. */
export const CHANNEL_SETTINGS_TAB_LABELS: Record<ChannelSettingsTab, string> = {
  overview: 'overview',
  permissions: 'permissions',
  webhooks: 'webhooks',
}
