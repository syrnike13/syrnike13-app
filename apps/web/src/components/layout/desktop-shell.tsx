import { Outlet, useMatch, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { ConnectionStatusBanner } from '#/components/layout/connection-status-banner'
import { HomeSidebar } from '#/components/home/home-sidebar'
import { ChannelSidebar } from '#/components/layout/channel-sidebar'
import { ShellContentFrame } from '#/components/layout/shell-content-frame'
import { ShellNavColumn } from '#/components/layout/shell-nav-column'
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

/**
 * Десктопная раскладка: рельс серверов + сайдбар + контент + плавающий UserPanel.
 *
 * Используется на роутах `/app/*`. Монтируется напрямую из `app/route.tsx`,
 * поэтому сам читает channel/settings match из активного роута.
 */
export function DesktopShell() {
  const { capabilities } = usePlatform()

  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const serverSettingsMatch = useMatch({
    from: '/app/servers/$serverId/settings',
    shouldThrow: false,
  })

  const activeChannelId =
    channelMatch && 'params' in channelMatch
      ? channelMatch.params.channelId
      : undefined
  const settingsChannelId =
    channelMatch && 'search' in channelMatch
      ? channelMatch.search?.settingsChannel
      : undefined
  const settingsTab = parseChannelSettingsTab(
    channelMatch && 'search' in channelMatch
      ? channelMatch.search?.settingsTab
      : undefined,
  )
  const highlightMessageId =
    channelMatch && 'search' in channelMatch
      ? channelMatch.search?.m
      : undefined

  const activeChannel = useSyncStore((s) =>
    activeChannelId ? s.channels[activeChannelId] : undefined,
  )
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

  const homeMatch = useMatch({
    from: '/app/',
    shouldThrow: false,
  })
  const onHomeRoute = !activeChannelId && Boolean(homeMatch || isHomePath)
  const dmContext = Boolean(activeChannel && isDmChannel(activeChannel))
  const showHomeSidebar = onHomeRoute || dmContext

  if (serverSettingsMatch) {
    return (
      <div className="theme-surface-app-frame fixed inset-0 z-50 flex h-svh w-full flex-col overflow-hidden text-foreground">
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
    <div className="theme-surface-lowest gradient-surface-lowest flex h-svh flex-col text-foreground">
      <ConnectionStatusBanner />
      <ShellTitleBar />
      <div className="relative flex min-h-0 flex-1">
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 items-stretch'
          )}
        >
          <ShellNavColumn sidebar={sidebar} overlay={<UserPanel />} />
          <ShellContentFrame>
            <Outlet />
          </ShellContentFrame>
        </div>

        <IncomingVoiceCallOverlay activeChannelId={activeChannelId} />
      </div>

      {settingsChannelId && activeChannelId ? (
        <div className="theme-surface-app-frame fixed inset-0 z-50 flex h-svh w-full flex-col overflow-hidden text-foreground">
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
