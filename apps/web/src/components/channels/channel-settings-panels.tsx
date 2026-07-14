import { ChannelSettingsOverviewPanel } from '#/components/channels/channel-settings-overview-panel'
import { ChannelSettingsPermissionsPanel } from '#/components/channels/channel-settings-permissions-panel'
import type { ChannelSettingsTab } from '#/components/channels/channel-settings-types'
import { ChannelSettingsWebhooksPanel } from '#/components/channels/channel-settings-webhooks-panel'
import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  serverChannelServerId,
  type ServerChannel,
} from '#/lib/channel-voice'
import {
  canManageChannel,
  canManageChannelPermissions,
  canManageChannelWebhooks,
} from '#/lib/permissions'

type ChannelSettingsPanelContentProps = {
  channel: ServerChannel
  tab: ChannelSettingsTab
}

export function ChannelSettingsPanelContent({
  channel,
  tab,
}: ChannelSettingsPanelContentProps) {
  const auth = useAuth()
  const serverId = serverChannelServerId(channel)
  const server = useSyncStore((s) => (serverId ? s.servers[serverId] : undefined))
  const member = useSyncStore((s) =>
    serverId && auth.user?._id
      ? s.members[`${serverId}:${auth.user._id}`]
      : undefined,
  )

  const canManage = canManageChannel(
    server,
    channel,
    member,
    auth.user?._id,
    auth.user?.privileged,
  )
  const canManagePermissions = canManageChannelPermissions(
    server,
    channel,
    member,
    auth.user?._id,
    auth.user?.privileged,
  )
  const canManageWebhooks = canManageChannelWebhooks(
    server,
    channel,
    member,
    auth.user?._id,
    auth.user?.privileged,
  )

  switch (tab) {
    case 'overview':
      return canManage ? <ChannelSettingsOverviewPanel channel={channel} /> : null
    case 'permissions':
      return canManagePermissions && server ? (
        <ChannelSettingsPermissionsPanel
          channel={channel}
          server={server}
          member={member}
        />
      ) : null
    case 'webhooks':
      return canManageWebhooks && channel.channel_type === 'TextChannel' ? (
        <ChannelSettingsWebhooksPanel channel={channel} />
      ) : null
    default:
      return null
  }
}
