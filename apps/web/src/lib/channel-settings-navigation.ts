import {
  parseChannelSettingsTab,
  type ChannelSettingsTab,
} from '#/components/channels/channel-settings-types'

export type ChannelRouteSearch = {
  m?: string
  settingsChannel?: string
  settingsTab?: ChannelSettingsTab
}

export function parseChannelRouteSearch(
  search: Record<string, unknown>,
): ChannelRouteSearch {
  const settingsChannel =
    typeof search.settingsChannel === 'string'
      ? search.settingsChannel
      : undefined

  return {
    m: typeof search.m === 'string' ? search.m : undefined,
    settingsChannel,
    settingsTab: settingsChannel
      ? parseChannelSettingsTab(search.settingsTab)
      : undefined,
  }
}

export function channelSettingsSearch({
  settingsChannel,
  settingsTab = 'overview',
  m,
}: {
  settingsChannel: string
  settingsTab?: ChannelSettingsTab
  m?: string
}): ChannelRouteSearch {
  return {
    ...(m ? { m } : {}),
    settingsChannel,
    settingsTab,
  }
}

export function clearChannelSettingsSearch(m?: string): ChannelRouteSearch {
  return m ? { m } : {}
}
