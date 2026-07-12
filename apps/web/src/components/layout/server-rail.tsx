import { Link, useMatch } from '@tanstack/react-router'
import { HashIcon, HomeIcon } from '#/components/icons'
import type { Server } from '@syrnike13/api-types'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { CreateServerDialog } from '#/components/servers/create-server-dialog'
import { PeopleRailSection } from '#/components/layout/people-rail-section'
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

type ServerRailVariant = 'desktop' | 'mobile'

function railButtonClass(active: boolean) {
  return cn(railIconButtonClass, !active && railIconIdleClass)
}

function ServerInitial({ name }: { name: string }) {
  return (
    <span className="text-xs font-semibold uppercase">
      {name.trim().slice(0, 2) || '??'}
    </span>
  )
}

/**
 * Рельс серверов.
 *
 * `variant`:
 *  - `desktop` — клик по серверу ведёт в первый канал (`/app/c/$id`);
 *    активность определяется контекстным сервером активного канала.
 *  - `mobile` — клик по серверу ведёт на `/m` + устанавливает `selectedServerId`;
 *    активность определяется `selectedServerId` из syncStore.
 *
 * Различие только в навигации и формуле «активности», вёрстка общая.
 */
export function ServerRail({
  variant,
  reserveUserPanelSpace = true,
}: {
  variant: ServerRailVariant
  reserveUserPanelSpace?: boolean
}) {
  const auth = useAuth()
  const { capabilities } = usePlatform()
  const ready = useSyncStore((s) => s.ready)
  const servers = useSyncStore(listServers)
  const homeBadge = useSyncStore((s) =>
    selectHomeNotificationBadge(s, auth.user?._id),
  )

  const homePath = variant === 'mobile' ? '/m/' : '/app/'
  const channelPath = variant === 'mobile' ? '/m/c/$channelId' : '/app/c/$channelId'
  const homeTo = variant === 'mobile' ? '/m' : '/app'

  const homeMatch = useMatch({ from: homePath, shouldThrow: false })
  const channelMatch = useMatch({ from: channelPath, shouldThrow: false })
  const activeChannelId =
    channelMatch && 'params' in channelMatch
      ? channelMatch.params.channelId
      : undefined
  const selectedServerId = useSyncStore((s) => s.selectedServerId)

  const homeActive =
    Boolean(homeMatch) &&
    !channelMatch &&
    (variant === 'desktop' || !selectedServerId)

  const railPaddingClass = capabilities.customWindowChrome ? 'pb-3' : 'py-3'
  const railBottomReserveStyle = reserveUserPanelSpace
    ? { paddingBottom: USER_PANEL_RESERVE_PX }
    : undefined

  if (!ready) {
    return (
      <div
        className={cn(
          'flex h-full w-14 shrink-0 flex-col items-center',
          railPaddingClass,
          shellNavSurface,
        )}
        style={railBottomReserveStyle}
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
      style={railBottomReserveStyle}
    >
      <Button
        size="icon"
        variant={homeActive ? 'default' : 'ghost'}
        className={railButtonClass(homeActive)}
        title="Главная"
        asChild
      >
        <Link
          to={homeTo}
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

      <div className="flex w-full flex-col items-center gap-2 overflow-visible px-1">
        <PeopleRailSection
          variant={variant}
          activeChannelId={activeChannelId}
        />
      </div>

      <ScrollArea className="min-h-0 w-full flex-1 px-2">
        <div className="flex flex-col items-center gap-2">
          {servers.map((server) => (
            <ServerRailButton
              key={server._id}
              server={server}
              currentUserId={auth.user?._id}
              activeChannelId={activeChannelId}
              variant={variant}
              homeMatch={Boolean(homeMatch)}
              channelMatch={Boolean(channelMatch)}
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

function ServerRailButton({
  server,
  currentUserId,
  activeChannelId,
  variant,
  homeMatch,
  channelMatch,
}: {
  server: Server
  currentUserId?: string
  activeChannelId?: string
  variant: ServerRailVariant
  homeMatch: boolean
  channelMatch: boolean
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

  const active =
    variant === 'mobile'
      ? homeMatch && !channelMatch && selectedServerId === server._id
      : channelMatch && !homeMatch && contextualServerId === server._id

  const content = (
    <span className="relative flex size-full items-center justify-center">
      <ServerInitial name={server.name} />
      <NotificationBadge
        badge={notificationBadge}
        className="absolute -top-1 -right-1"
      />
    </span>
  )

  const channelTo = variant === 'mobile' ? '/m/c/$channelId' : '/app/c/$channelId'
  const homeTo = variant === 'mobile' ? '/m' : '/app'

  // Desktop: ведём сразу в первый канал сервера.
  // Mobile: ведём на home с установкой selectedServerId (sidebar каналов покажется рядом).
  if (firstChannelId && variant === 'desktop') {
    return (
      <Button
        size="icon"
        variant={active ? 'default' : 'ghost'}
        className={railButtonClass(active)}
        title={server.name}
        asChild
      >
        <Link
          to={channelTo}
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
        to={homeTo}
        search={{ tab: 'online' }}
        replace={channelMatch}
        onClick={() => syncStore.setSelectedServerId(server._id)}
      >
        {content}
      </Link>
    </Button>
  )
}
