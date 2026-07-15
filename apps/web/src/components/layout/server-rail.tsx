import { useMatch } from '@tanstack/react-router'
import { HashIcon, HomeIcon } from '#/components/icons'
import type { Server } from '@syrnike13/api-types'
import { useState } from 'react'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import { ScrollArea } from '#/components/ui/scroll-area'
import { Squircle } from '#/components/ui/squircle'
import { CreateServerDialog } from '#/components/servers/create-server-dialog'
import { PeopleRailSection } from '#/components/layout/people-rail-section'
import { RailIconButton } from '#/components/layout/rail-icon-button'
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
  railColumnInsetClass,
  railIconButtonClass,
  railIconIdleClass,
  railIconSquircleProps,
  railServerScrollAreaClass,
  railServerScrollContentClass,
  shellLowestSurface,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { serverIconUrl } from '#/lib/media'
import { useMediaQuery } from '#/hooks/use-media-query'

type ServerRailVariant = 'desktop' | 'mobile'

function ServerIcon({
  server,
  animated,
}: {
  server: Server
  animated: boolean
}) {
  const iconUrl = serverIconUrl(server.icon, { animated })

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        draggable={false}
        className="size-full object-cover"
      />
    )
  }

  return (
    <span className="text-xs font-semibold uppercase">
      {server.name.trim().slice(0, 2) || '??'}
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
  userPanelReservePx = USER_PANEL_RESERVE_PX,
}: {
  variant: ServerRailVariant
  reserveUserPanelSpace?: boolean
  userPanelReservePx?: number
}) {
  const auth = useAuth()
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
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)',
  )

  const homeActive =
    Boolean(homeMatch) &&
    !channelMatch &&
    (variant === 'desktop' || !selectedServerId)

  const railBottomReserveStyle = reserveUserPanelSpace
    ? { paddingBottom: userPanelReservePx }
    : undefined

  if (!ready) {
    return (
        <div
          className={cn(
            'flex h-full w-16 shrink-0 flex-col items-center',
            'pt-1 pb-3',
            shellLowestSurface,
          )}
          style={railBottomReserveStyle}
        >
          <Squircle
            {...railIconSquircleProps}
            className={cn(railIconButtonClass, 'animate-pulse bg-muted')}
          />
        </div>
    )
  }

  return (
    <div
      className={cn(
        'flex h-full w-16 shrink-0 flex-col',
        'pt-1 pb-3',
        shellLowestSurface,
      )}
      style={railBottomReserveStyle}
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col items-center gap-2',
          railColumnInsetClass,
        )}
      >
        <RailIconButton
          active={homeActive}
          title="Главная"
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
        </RailIconButton>

        <PeopleRailSection
          variant={variant}
          activeChannelId={activeChannelId}
        />

        <ScrollArea
          className={cn('min-h-0 flex-1', railServerScrollAreaClass)}
        >
          <div
            className={cn(
              'flex flex-col items-center gap-2',
              railServerScrollContentClass,
            )}
          >
            {servers.map((server) => (
              <ServerRailButton
                key={server._id}
                server={server}
                currentUserId={auth.user?._id}
                activeChannelId={activeChannelId}
                variant={variant}
                channelMatch={Boolean(channelMatch)}
                prefersReducedMotion={prefersReducedMotion}
              />
            ))}
            {servers.length === 0 ? (
              <Squircle
                {...railIconSquircleProps}
                className={cn(
                  railIconButtonClass,
                  railIconIdleClass,
                  'flex items-center justify-center text-foreground',
                )}
                title="Нет серверов"
              >
                <HashIcon className="size-4" />
              </Squircle>
            ) : null}

            <CreateServerDialog />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function ServerRailButton({
  server,
  currentUserId,
  activeChannelId,
  variant,
  channelMatch,
  prefersReducedMotion,
}: {
  server: Server
  currentUserId?: string
  activeChannelId?: string
  variant: ServerRailVariant
  channelMatch: boolean
  prefersReducedMotion: boolean
}) {
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const [iconInteractionActive, setIconInteractionActive] = useState(false)
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
      ? !channelMatch && selectedServerId === server._id
      : Boolean(channelMatch) && contextualServerId === server._id

  const icon = (
    <span className="flex size-full items-center justify-center">
      <ServerIcon
        server={server}
        animated={iconInteractionActive && !prefersReducedMotion}
      />
    </span>
  )

  const channelTo = variant === 'mobile' ? '/m/c/$channelId' : '/app/c/$channelId'
  const homeTo = variant === 'mobile' ? '/m' : '/app'

  // Desktop: ведём сразу в первый канал сервера.
  // Mobile: ведём на home с установкой selectedServerId (sidebar каналов покажется рядом).
  if (firstChannelId && variant === 'desktop') {
    return (
      <RailIconButton
        active={active}
        unread={notificationBadge.hasUnread}
        title={server.name}
        to={channelTo}
        params={{ channelId: firstChannelId }}
        search={{ m: undefined }}
        onPointerEnter={() => setIconInteractionActive(true)}
        onPointerLeave={() => setIconInteractionActive(false)}
        onFocus={() => setIconInteractionActive(true)}
        onBlur={() => setIconInteractionActive(false)}
      >
        {icon}
      </RailIconButton>
    )
  }

  return (
    <RailIconButton
      active={active}
      unread={notificationBadge.hasUnread}
      title={server.name}
      to={homeTo}
      search={{ tab: 'online' }}
      replace={channelMatch}
      onClick={() => syncStore.setSelectedServerId(server._id)}
      onPointerEnter={() => setIconInteractionActive(true)}
      onPointerLeave={() => setIconInteractionActive(false)}
      onFocus={() => setIconInteractionActive(true)}
      onBlur={() => setIconInteractionActive(false)}
    >
      {icon}
    </RailIconButton>
  )
}
