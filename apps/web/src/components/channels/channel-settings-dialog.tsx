import { useTranslations } from '@syrnike13/ui/i18n'
import { SettingsIcon } from '#/components/icons'
import { useMatch, useNavigate } from '@tanstack/react-router'

import { Button } from '@syrnike13/ui/primitives/button'
import { useAuth } from '#/features/auth/auth-context'
import {
  useAppRouteIdPrefix,
  useAppRoutePrefix,
} from '#/features/navigation/route-prefix'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { channelSettingsSearch } from '#/lib/channel-settings-navigation'
import {
  serverChannelServerId,
  type ServerChannel,
} from '@syrnike13/client/lib/channel-voice'
import {
  canManageChannel,
  canManageChannelPermissions,
  canManageChannelWebhooks,
} from '#/features/authorization/authorization'

type ChannelSettingsDialogProps = {
  channel: ServerChannel
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChannelSettingsDialog({
  channel,
  open: _controlledOpen,
  onOpenChange,
}: ChannelSettingsDialogProps) {
  const t = useTranslations('channels')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const routePrefix = useAppRouteIdPrefix()
  const channelRouteMatch = useMatch({
    from: `${routePrefix}/c/$channelId`,
    shouldThrow: false,
  })
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
  )
  const canManagePermissions = canManageChannelPermissions(
    server,
    channel,
    member,
    auth.user?._id,
  )
  const canManageWebhooks = canManageChannelWebhooks(
    server,
    channel,
    member,
    auth.user?._id,
  )

  if (!canManage && !canManagePermissions && !canManageWebhooks) return null

  function openSettings() {
    onOpenChange?.(false)
    const match = channelRouteMatch
    const hostChannelId =
      (match && 'params' in match ? match.params.channelId : undefined) ??
      channel._id
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId: hostChannelId },
      search: channelSettingsSearch({
        settingsChannel: channel._id,
        settingsTab: canManage
          ? 'overview'
          : canManagePermissions
            ? 'permissions'
            : 'webhooks',
        m: match && 'search' in match ? match.search?.m : undefined,
      }),
    })
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={t('channelSettings')}
      onClick={openSettings}
    >
      <SettingsIcon className="size-4" />
    </Button>
  )
}
