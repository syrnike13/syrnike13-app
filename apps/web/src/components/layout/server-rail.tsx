import { Link, useMatch } from '@tanstack/react-router'
import { HashIcon, HomeIcon } from '#/components/icons'
import type { Server } from '@syrnike13/api-types'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { CreateServerDialog } from '#/components/servers/create-server-dialog'
import { useAuth } from '#/features/auth/auth-context'
import {
  selectHomeNotificationBadge,
  selectServerNotificationBadge,
} from '#/features/notifications/notification-selectors'
import { listServerChannels, listServers } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { selectedServerIdForChannel } from '#/features/navigation/channel-server-context'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import {
  railIconButtonClass,
  railIconIdleClass,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
import { usePlatform } from '#/platform/use-platform'
import { cn } from '#/lib/utils'

function railButtonClass(active: boolean) {
  return cn(railIconButtonClass, !active && railIconIdleClass)
}

function ServerRailButton({
  server,
  currentUserId,
  activeChannelId,
}: {
  server: Server
  currentUserId?: string
  activeChannelId?: string
}) {
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const activeChannel = useSyncStore((s) =>
    activeChannelId ? s.channels[activeChannelId] : undefined,
  )
  const contextualServerId = activeChannelId
    ? selectedServerIdForChannel(activeChannel)
    : selectedServerId
  const notificationBadge = useSyncStore((s) =>
    selectServerNotificationBadge(s, server._id, currentUserId),
  )
  const firstChannelId = useSyncStore((s) => {
    const channels = listServerChannels(s, server._id, currentUserId)
    const text = channels.find((c) => c.channel_type === 'TextChannel')
    return (text ?? channels[0])?._id
  })

  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const active =
    Boolean(channelMatch) &&
    !homeMatch &&
    contextualServerId === server._id

  const content = (
    <span className="relative flex size-full items-center justify-center">
      <ServerInitial name={server.name} />
      <NotificationBadge
        badge={notificationBadge}
        className="absolute -top-1 -right-1"
      />
    </span>
  )

  if (firstChannelId) {
    return (
      <Button
        size="icon"
        variant={active ? 'default' : 'ghost'}
        className={railButtonClass(active)}
        title={server.name}
        asChild
      >
        <Link
          to="/app/c/$channelId"
          params={{ channelId: firstChannelId }}
          search={{ m: undefined }}
        >
          {content}
        </Link>
      </Button>
    )
  }

  return (
    <Button
      size="icon"
      variant={active ? 'default' : 'ghost'}
      className={railButtonClass(active)}
      title={server.name}
      asChild
    >
      <Link
        to="/app"
        search={{ tab: 'online' }}
        onClick={() => syncStore.setSelectedServerId(server._id)}
      >
        {content}
      </Link>
    </Button>
  )
}

function ServerInitial({ name }: { name: string }) {
  return (
    <span className="text-xs font-semibold uppercase">
      {name.trim().slice(0, 2) || '??'}
    </span>
  )
}

export function ServerRail() {
  const auth = useAuth()
  const { capabilities } = usePlatform()
  const ready = useSyncStore((s) => s.ready)
  const servers = useSyncStore(listServers)
  const homeBadge = useSyncStore((s) =>
    selectHomeNotificationBadge(s, auth.user?._id),
  )

  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const activeChannelId = channelMatch?.params?.channelId

  const homeActive = Boolean(homeMatch) && !channelMatch

  const railPaddingClass = capabilities.customWindowChrome ? 'pb-3' : 'py-3'

  if (!ready) {
    return (
      <div
        className={cn(
          'flex h-full w-14 shrink-0 flex-col items-center',
          railPaddingClass,
          shellNavSurface,
        )}
        style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
      >
        <div className={cn(railIconButtonClass, 'animate-pulse bg-muted')} />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex h-full w-14 shrink-0 flex-col items-center gap-2',
        railPaddingClass,
        shellNavSurface,
      )}
      style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
    >
      <Button
        size="icon"
        variant={homeActive ? 'default' : 'ghost'}
        className={railButtonClass(homeActive)}
        title="Главная"
        asChild
      >
        <Link
          to="/app"
          search={{ tab: 'online' }}
          onClick={() => syncStore.setSelectedServerId(null)}
        >
          <span className="relative flex size-full items-center justify-center">
            <HomeIcon />
            <NotificationBadge
              badge={homeBadge}
              className="absolute -top-1 -right-1"
            />
          </span>
        </Link>
      </Button>

      <ScrollArea className="min-h-0 w-full flex-1 px-2">
        <div className="flex flex-col items-center gap-2">
          {servers.map((server) => (
            <ServerRailButton
              key={server._id}
              server={server}
              currentUserId={auth.user?._id}
              activeChannelId={activeChannelId}
            />
          ))}
          {servers.length === 0 ? (
            <div
              className={cn(
                railIconButtonClass,
                railIconIdleClass,
                'flex items-center justify-center text-foreground',
              )}
              title="Нет серверов"
            >
              <HashIcon className="size-4" />
            </div>
          ) : null}

          <CreateServerDialog />
        </div>
      </ScrollArea>
    </div>
  )
}
