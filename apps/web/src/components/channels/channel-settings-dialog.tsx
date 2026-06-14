import type { Channel } from '@syrnike13/api-types'
import { SettingsIcon } from '#/components/icons'
import { useMatch, useNavigate } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useSyncStore } from '#/features/sync/sync-store'
import { channelSettingsSearch } from '#/lib/channel-settings-navigation'
import { canManageChannel, canManageChannelPermissions } from '#/lib/permissions'

type ServerChannel = Extract<
  Channel,
  { channel_type: 'TextChannel' | 'VoiceChannel' }
>

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
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const channelRouteMatch = useMatch({
    from: `${prefix}/c/$channelId`,
    shouldThrow: false,
  })
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

  if (!canManage && !canManagePermissions) return null

  function openSettings() {
    onOpenChange?.(false)
    const match = channelRouteMatch
    const hostChannelId = (match && 'params' in match ? match.params.channelId : undefined) ?? channel._id
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId: hostChannelId },
      search: channelSettingsSearch({
        settingsChannel: channel._id,
        settingsTab: canManage ? 'overview' : 'permissions',
        m: match && 'search' in match ? match.search?.m : undefined,
      }),
    })
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8"
      title="Настройки канала"
      onClick={openSettings}
    >
      <SettingsIcon className="size-4" />
    </Button>
  )
}
