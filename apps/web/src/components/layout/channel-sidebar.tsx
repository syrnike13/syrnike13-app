import { useEffect, useRef } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { ServerChannelList } from '#/components/channels/server-channel-list'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import {
  listVisibleDmRailChannels,
} from '#/features/sync/selectors'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import {
  GUILD_BANNER_FADE_DISTANCE_PX,
  GUILD_BANNER_HEIGHT_CLASS,
  GUILD_BANNER_MAX_SHIFT_PX,
  shellColumnHeaderClass,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { serverBannerUrl } from '#/lib/media'
import { useMediaQuery } from '#/hooks/use-media-query'
import { ServerHeaderMenu } from '#/components/servers/server-header-menu'
import { useServerMembersSync } from '#/features/sync/server-members-sync'
import { useSyncStore } from '#/features/sync/sync-store'

type ChannelSidebarProps = {
  activeChannelId?: string
  reserveUserPanelSpace?: boolean
  userPanelReservePx?: number
}

export function ChannelSidebar({
  activeChannelId,
  reserveUserPanelSpace = true,
  userPanelReservePx = USER_PANEL_RESERVE_PX,
}: ChannelSidebarProps) {
  const auth = useAuth()
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const users = useSyncStore((s) => s.users)
  const unreads = useSyncStore((s) => s.unreads)
  const t = useTranslations('layout.channel')
  const servers = useSyncStore((s) => s.servers)
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)',
  )

  const dmChannels = useSyncStore((s) =>
    listVisibleDmRailChannels(s, auth.user?._id),
  )

  useServerMembersSync(selectedServerId, auth.session?.token)

  const selectedServer = selectedServerId
    ? servers[selectedServerId]
    : undefined
  const serverName = selectedServer?.name ?? t('directMessages')
  const bannerUrl = serverBannerUrl(selectedServer?.banner, {
    animated: !prefersReducedMotion,
  })
  const sidebarRef = useRef<HTMLElement>(null)
  const bannerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = sidebarRef.current
    const banner = bannerRef.current
    if (!root || !banner || !bannerUrl) return

    const viewport = root.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return

    let frame = 0
    const apply = () => {
      frame = 0
      const progress = Math.min(
        viewport.scrollTop / GUILD_BANNER_FADE_DISTANCE_PX,
        1,
      )
      banner.style.setProperty('--banner-opacity', String(1 - progress))
      banner.style.setProperty(
        '--banner-shift',
        `${-progress * GUILD_BANNER_MAX_SHIFT_PX}px`,
      )
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [bannerUrl, selectedServerId])

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'relative flex h-full min-h-0 w-full flex-col',
        shellNavSurface,
        reserveUserPanelSpace && 'pb-(--sidebar-bottom-reserve)',
      )}
      style={
        reserveUserPanelSpace
          ? ({
              '--sidebar-bottom-reserve': `${userPanelReservePx}px`,
            } as CSSVars)
          : undefined
      }
    >
      {bannerUrl ? (
        <div
          ref={bannerRef}
          aria-hidden="true"
          data-server-banner=""
          className={cn(
            'banner-scroll pointer-events-none absolute inset-x-0 top-0 z-0 overflow-hidden',
            GUILD_BANNER_HEIGHT_CLASS,
          )}
          style={
            {
              '--banner-opacity': 1,
              '--banner-shift': '0px',
            } as CSSVars
          }
        >
          <img
            src={bannerUrl}
            alt=""
            draggable={false}
            className="size-full object-cover"
          />
          <span className="absolute inset-0 bg-linear-to-b from-background/85 via-background/35 to-transparent" />
        </div>
      ) : null}
      <header
        className={cn(
          shellColumnHeaderClass,
          'relative z-10 overflow-hidden px-2',
          bannerUrl ? 'border-b-0' : 'bg-transparent',
        )}
      >
        {selectedServerId ? (
          <div className="relative z-10 flex w-full">
            <ServerHeaderMenu
              serverId={selectedServerId}
              serverName={serverName}
              overBanner={Boolean(bannerUrl)}
            />
          </div>
        ) : (
          <h2 className="min-w-0 flex-1 truncate px-1 text-base font-semibold tracking-tight">
            {serverName}
          </h2>
        )}
      </header>

      <ScrollArea className="relative z-10 min-h-0 flex-1">
        {selectedServerId ? (
          <ServerChannelList
            serverId={selectedServerId}
            activeChannelId={activeChannelId}
            users={users}
            currentUserId={auth.user?._id}
            unreads={unreads}
            bannerOffset={Boolean(bannerUrl)}
          />
        ) : (
          <div className="min-h-full p-2">
            {dmChannels.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                {t('noChannels')}
              </p>
            ) : (
              <nav>
                <ul className="flex flex-col gap-0.5">
                  {dmChannels.map((channel) => (
                    <li key={channel._id}>
                      <ChannelSidebarItem
                        channel={channel}
                        activeChannelId={activeChannelId}
                        users={users}
                        currentUserId={auth.user?._id}
                        unreads={unreads}
                      />
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}
