import {
  Outlet,
  useMatch,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect } from 'react'

import { ConnectionStatusBanner } from '#/components/layout/connection-status-banner'
import { HomeSidebar } from '#/components/home/home-sidebar'
import { ChannelSidebar } from '#/components/layout/channel-sidebar'
import { ServerRail } from '#/components/layout/server-rail'
import { MobileUserPanel } from '#/components/layout/mobile/mobile-user-panel'
import { MobileVoiceFloatingTile } from '#/components/layout/mobile/mobile-voice-floating-tile'
import { IncomingVoiceCallOverlay } from '#/components/voice/incoming-voice-call-overlay'
import { selectedServerIdForChannel } from '#/features/navigation/channel-server-context'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { parseChannelSettingsTab } from '#/components/channels/channel-settings-types'
import { ChannelSettingsPage } from '#/components/channels/channel-settings-page'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

/**
 * Мобильная раскладка в стиле Discord mobile.
 *
 * Список: узкая рельса серверов слева + список каналов/DM рядом; снизу —
 * плавающая панель аккаунта (`MobileUserPanel`).
 *
 * Чат и профиль: на `/m/c/$channelId` и `/m/profile` — на весь экран;
 * выбор сервера на рельсе остаётся в колонке списка каналов.
 *
 * Монтируется напрямую из `m/route.tsx` (без фасада `AppShell`),
 * поэтому сама читает channel/settings match из активного роута.
 */
export function MobileShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isHomePath = pathname === '/m' || pathname === '/m/'

  const channelMatch = useMatch({
    from: '/m/c/$channelId',
    shouldThrow: false,
  })
  const serverSettingsMatch = useMatch({
    from: '/m/servers/$serverId/settings',
    shouldThrow: false,
  })

  const activeChannelId = channelMatch ? channelMatch.params.channelId : undefined
  const settingsChannelId = channelMatch ? channelMatch.search?.settingsChannel : undefined
  const settingsTab = parseChannelSettingsTab(
    channelMatch ? channelMatch.search?.settingsTab : undefined,
  )
  const highlightMessageId = channelMatch ? channelMatch.search?.m : undefined

  const activeChannel = useSyncStore((s) =>
    activeChannelId ? s.channels[activeChannelId] : undefined,
  )

  const homeMatch = useMatch({ from: '/m/', shouldThrow: false })
  const profileMatch = useMatch({ from: '/m/profile', shouldThrow: false })
  const serverSettingsActive = Boolean(serverSettingsMatch)

  const isChannelRoute = Boolean(activeChannelId)
  const onHomeRoute = !activeChannelId && (Boolean(homeMatch) || isHomePath)
  const selectedServerId = useSyncStore((s) => s.selectedServerId)

  useEffect(() => {
    if (!activeChannelId) return
    if (!activeChannel) return
    syncStore.setSelectedServerId(selectedServerIdForChannel(activeChannel))
  }, [activeChannel, activeChannelId])

  if (serverSettingsActive) {
    return (
      <div className="fixed inset-0 z-50 flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
        <Outlet />
      </div>
    )
  }

  const isProfileRoute = Boolean(profileMatch)
  const showChatFullscreen = isProfileRoute || isChannelRoute
  const showHomeSidebar = onHomeRoute && !selectedServerId

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <ConnectionStatusBanner />

      {showChatFullscreen ? (
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            !isProfileRoute && 'pt-[env(safe-area-inset-top)]',
          )}
        >
          <Outlet />
        </div>
      ) : (
        <div
          className={cn(
            'relative flex min-h-0 flex-1 pt-[env(safe-area-inset-top)]',
          )}
        >
          <ServerRail variant="mobile" />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 pl-2 pt-2">
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl border shadow-sm',
                shellDivider,
                shellNavSurface,
              )}
            >
              {showHomeSidebar ? (
                <HomeSidebar activeChannelId={activeChannelId} />
              ) : (
                <ChannelSidebar activeChannelId={activeChannelId} />
              )}
            </div>
          </div>
          <MobileUserPanel />
        </div>
      )}

      <IncomingVoiceCallOverlay activeChannelId={activeChannelId} />
      <MobileVoiceFloatingTile />

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
