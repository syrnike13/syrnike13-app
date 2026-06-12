import type { Channel } from '@syrnike13/api-types'

import { ChannelSettingsOverviewPanel } from '#/components/channels/channel-settings-overview-panel'
import { ChannelSettingsPermissionsPanel } from '#/components/channels/channel-settings-permissions-panel'
import type { ChannelSettingsTab } from '#/components/channels/channel-settings-types'
import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  canManageChannel,
  canManageChannelPermissions,
} from '#/lib/permissions'

type ServerChannel = Extract<
  Channel,
  { channel_type: 'TextChannel' | 'VoiceChannel' }
>

type ChannelSettingsPanelContentProps = {
  channel: ServerChannel
  tab: ChannelSettingsTab
}

export function ChannelSettingsPanelContent({
  channel,
  tab,
}: ChannelSettingsPanelContentProps) {
  const auth = useAuth()
  const server = useSyncStore((s) =>
    channel.server ? s.servers[channel.server] : undefined,
  )
  const member = useSyncStore((s) =>
    channel.server && auth.user?._id
      ? s.members[`${channel.server}:${auth.user._id}`]
      : undefined,
  )

  const canManage = canManageChannel(
    server,
    channel,
    member,
    auth.user?._id,
  )
  const canManagePermissions = canManageChannelPermissions(
    server,
    channel,
    member,
    auth.user?._id,
  )

  switch (tab) {
    case 'overview':
      return canManage ? <ChannelSettingsOverviewPanel channel={channel} /> : null
    case 'permissions':
      return canManagePermissions &&
        channel.channel_type === 'TextChannel' &&
        server ? (
        <ChannelSettingsPermissionsPanel
          channel={channel}
          server={server}
          member={member}
        />
      ) : null
    default:
      return null
  }
}
