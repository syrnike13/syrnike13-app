import { Outlet, useMatch, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { ConnectionStatusBanner } from '#/components/layout/connection-status-banner'
import { HomeSidebar } from '#/components/home/home-sidebar'
import { ChannelSidebar } from '#/components/layout/channel-sidebar'
import { ShellContentFrame } from '#/components/layout/shell-content-frame'
import { ShellNavColumn } from '#/components/layout/shell-nav-column'
import { ShellTitleBar } from '#/components/layout/shell-title-bar'
import { UserPanel } from '#/components/layout/user-panel'
import {
  USER_PANEL_RESERVE_PX,
  USER_PANEL_WITH_TELEGRAM_PROMO_RESERVE_PX,
} from '#/components/layout/left-sidebar-stack'
import { IncomingVoiceCallOverlay } from '#/components/voice/incoming-voice-call-overlay'
import { selectedServerIdForChannel } from '#/features/navigation/channel-server-context'
import { isDmChannel } from '#/features/sync/channel-label'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { parseChannelSettingsTab } from '#/components/channels/channel-settings-types'
import { ChannelSettingsPage } from '#/components/channels/channel-settings-page'
import { cn } from '#/lib/utils'
import { useAuth } from '#/features/auth/auth-context'

const TELEGRAM_PROMO_DISMISSED_STORAGE_KEY =
  'syrnike13.telegramPromoDismissed'
const TELEGRAM_PROMO_DISMISS_DURATION_MS = 14 * 24 * 60 * 60 * 1000

function telegramPromoStorageKey(userId: string) {
  return `${TELEGRAM_PROMO_DISMISSED_STORAGE_KEY}:${userId}`
}

/**
 * Десктопная раскладка: рельс серверов + сайдбар + контент + плавающий UserPanel.
 *
 * Используется на роутах `/app/*`. Монтируется напрямую из `app/route.tsx`,
 * поэтому сам читает channel/settings match из активного роута.
 */
export function DesktopShell() {
  const auth = useAuth()
  const userId = auth.user?._id
  const [telegramPromoState, setTelegramPromoState] = useState<{
    userId?: string
    visible: boolean
    dismissedUntil?: number
  }>({ visible: false })
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
  const isFeedbackPath = pathname.startsWith('/app/feedback')

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
  const onHomeRoute =
    !activeChannelId && Boolean(homeMatch || isHomePath || isFeedbackPath)
  const dmContext = Boolean(activeChannel && isDmChannel(activeChannel))
  const showHomeSidebar = onHomeRoute || dmContext

  useEffect(() => {
    if (!userId) {
      setTelegramPromoState({ visible: false })
      return
    }

    let dismissedUntil: number | undefined
    try {
      const storedValue = Number(
        window.localStorage.getItem(telegramPromoStorageKey(userId)),
      )
      if (Number.isFinite(storedValue) && storedValue > Date.now()) {
        dismissedUntil = storedValue
      }
    } catch {
      // localStorage может быть недоступен в приватном режиме.
    }
    setTelegramPromoState({
      userId,
      visible: dismissedUntil == null,
      dismissedUntil,
    })
  }, [userId])

  useEffect(() => {
    const dismissedUntil = telegramPromoState.dismissedUntil
    if (!dismissedUntil || telegramPromoState.userId !== userId) return

    const timeout = window.setTimeout(() => {
      setTelegramPromoState((current) =>
        current.userId === userId
          ? { userId, visible: true }
          : current,
      )
    }, Math.max(0, dismissedUntil - Date.now()))

    return () => window.clearTimeout(timeout)
  }, [telegramPromoState.dismissedUntil, telegramPromoState.userId, userId])

  const telegramPromoVisible =
    telegramPromoState.userId === userId && telegramPromoState.visible
  const userPanelReservePx = telegramPromoVisible
    ? USER_PANEL_WITH_TELEGRAM_PROMO_RESERVE_PX
    : USER_PANEL_RESERVE_PX

  const dismissTelegramPromo = () => {
    if (!userId) return
    const dismissedUntil = Date.now() + TELEGRAM_PROMO_DISMISS_DURATION_MS
    setTelegramPromoState({ userId, visible: false, dismissedUntil })
    try {
      window.localStorage.setItem(
        telegramPromoStorageKey(userId),
        String(dismissedUntil),
      )
    } catch {
      // Скрываем хотя бы до следующей загрузки, если storage недоступен.
    }
  }

  if (serverSettingsMatch) {
    return (
      <div className="theme-surface-app-frame fixed inset-0 z-50 flex h-svh w-full flex-col overflow-hidden text-foreground">
        <Outlet />
      </div>
    )
  }

  const sidebar = showHomeSidebar ? (
    <HomeSidebar
      activeChannelId={activeChannelId}
      userPanelReservePx={userPanelReservePx}
    />
  ) : (
    <ChannelSidebar
      activeChannelId={activeChannelId}
      userPanelReservePx={userPanelReservePx}
    />
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
          <ShellNavColumn
            sidebar={sidebar}
            overlay={
              <UserPanel
                telegramPromoVisible={telegramPromoVisible}
                onDismissTelegramPromo={dismissTelegramPromo}
              />
            }
            userPanelReservePx={userPanelReservePx}
          />
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
