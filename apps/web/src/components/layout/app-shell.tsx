import { Outlet, useMatch, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { HomeSidebar } from '#/components/home/home-sidebar'
import { AppMainFrame } from '#/components/layout/app-main-frame'
import { ChannelSidebar } from '#/components/layout/channel-sidebar'
import { LeftSidebarStack } from '#/components/layout/left-sidebar-stack'
import { ServerRail } from '#/components/layout/server-rail'
import { UserPanel } from '#/components/layout/user-panel'
import { SecondarySidebar } from '#/components/layout/secondary-sidebar'
import { isDmChannel } from '#/features/sync/channel-label'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'

export function AppShell() {
  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const discoverMatch = useMatch({
    from: '/app/discover',
    shouldThrow: false,
  })
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const activeChannelId = channelMatch?.params.channelId
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isHomePath = pathname === '/app' || pathname === '/app/'

  useEffect(() => {
    if (isHomePath && !activeChannelId && !discoverMatch) {
      syncStore.setSelectedServerId(null)
      return
    }
    if (!activeChannelId) return
    const channel = syncStore.getState().channels[activeChannelId]
    if (!channel) return
    const nextServerId = isDmChannel(channel)
      ? null
      : channel.channel_type === 'TextChannel' ||
          channel.channel_type === 'VoiceChannel'
        ? channel.server
        : null
    syncStore.setSelectedServerId(nextServerId)
  }, [activeChannelId, isHomePath, discoverMatch])

  const activeChannel = useSyncStore((s) =>
    activeChannelId ? s.channels[activeChannelId] : undefined,
  )
  const onHomeRoute =
    !discoverMatch &&
    !activeChannelId &&
    (Boolean(homeMatch) || isHomePath)

  const dmContext =
    selectedServerId === null &&
    Boolean(activeChannel && isDmChannel(activeChannel))

  const showHomeSidebar = onHomeRoute || dmContext

  const showChannelSidebar = !showHomeSidebar && !discoverMatch

  const sidebar = showHomeSidebar ? (
    <HomeSidebar activeChannelId={activeChannelId} />
  ) : showChannelSidebar ? (
    <ChannelSidebar activeChannelId={activeChannelId} />
  ) : (
    <SecondarySidebar />
  )

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1">
        <ServerRail />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 pt-2 pl-2">
          <AppMainFrame
            sidebar={
              <LeftSidebarStack>{sidebar}</LeftSidebarStack>
            }
          >
            <Outlet />
          </AppMainFrame>
        </div>

        <UserPanel />
      </div>
    </div>
  )
}
