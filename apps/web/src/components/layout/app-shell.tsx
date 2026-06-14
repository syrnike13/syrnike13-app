import { Outlet, useMatch, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { ConnectionStatusBanner } from '#/components/layout/connection-status-banner'
import { HomeSidebar } from '#/components/home/home-sidebar'
import { AppMainFrame } from '#/components/layout/app-main-frame'
import { ChannelSidebar } from '#/components/layout/channel-sidebar'
import { LeftSidebarStack } from '#/components/layout/left-sidebar-stack'
import { ServerRail } from '#/components/layout/server-rail'
import { ShellTitleBar } from '#/components/layout/shell-title-bar'
import { UserPanel } from '#/components/layout/user-panel'
import { IncomingVoiceCallOverlay } from '#/components/voice/incoming-voice-call-overlay'
import { selectedServerIdForChannel } from '#/features/navigation/channel-server-context'
import { isDmChannel } from '#/features/sync/channel-label'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { usePlatform } from '#/platform/use-platform'
import { parseChannelSettingsTab } from '#/components/channels/channel-settings-types'
import { ChannelSettingsPage } from '#/components/channels/channel-settings-page'
import { cn } from '#/lib/utils'

export function AppShell() {
  const { capabilities } = usePlatform()
  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const serverSettingsMatch = useMatch({
    from: '/app/servers/$serverId/settings',
    shouldThrow: false,
  })
  const activeChannelId = channelMatch?.params.channelId
  const activeChannel = useSyncStore((s) =>
    activeChannelId ? s.channels[activeChannelId] : undefined,
  )
  const settingsChannelId = channelMatch?.search?.settingsChannel
  const settingsTab = parseChannelSettingsTab(channelMatch?.search?.settingsTab)
  const highlightMessageId = channelMatch?.search?.m
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isHomePath = pathname === '/app' || pathname === '/app/'

  useEffect(() => {
    if (isHomePath && !activeChannelId) {
      syncStore.setSelectedServerId(null)
      return
    }
    if (!activeChannelId) return
    if (!activeChannel) return
    syncStore.setSelectedServerId(selectedServerIdForChannel(activeChannel))
  }, [activeChannel, activeChannelId, isHomePath])
  const onHomeRoute =
    !activeChannelId && (Boolean(homeMatch) || isHomePath)

  const dmContext = Boolean(activeChannel && isDmChannel(activeChannel))

  const showHomeSidebar = onHomeRoute || dmContext

  if (serverSettingsMatch) {
    return (
      <div className="fixed inset-0 z-50 flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
        <Outlet />
      </div>
    )
  }

  const sidebar = showHomeSidebar ? (
    <HomeSidebar activeChannelId={activeChannelId} />
  ) : (
    <ChannelSidebar activeChannelId={activeChannelId} />
  )

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <ConnectionStatusBanner />
      <ShellTitleBar />
      <div className="relative flex min-h-0 flex-1">
        <ServerRail />

        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col gap-2 pl-2',
            !capabilities.customWindowChrome && 'pt-2',
          )}
        >
          <AppMainFrame sidebar={<LeftSidebarStack>{sidebar}</LeftSidebarStack>}>
            <Outlet />
          </AppMainFrame>
        </div>

        <UserPanel />
        <IncomingVoiceCallOverlay activeChannelId={activeChannelId} />
      </div>

      {settingsChannelId && activeChannelId ? (
        <div className="fixed inset-0 z-50 flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
          <ChannelSettingsPage
            channelId={settingsChannelId}
            hostChannelId={activeChannelId}
            tab={settingsTab}
            highlightMessageId={highlightMessageId}
          />
        </div>
      ) : null}
    </div>
  )
}
