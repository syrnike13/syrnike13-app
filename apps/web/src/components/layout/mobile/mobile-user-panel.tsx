import { Link } from '@tanstack/react-router'
import { BellIcon, ChevronDownIcon } from '#/components/icons'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { selectHomeNotificationBadge } from '#/features/notifications/notification-selectors'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useSyncStore } from '#/features/sync/sync-store'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { userStatusSubtitle } from '#/lib/presence'
import { cn } from '#/lib/utils'

const gatewayLabels = {
  idle: 'Не подключён',
  connecting: 'Подключение…',
  connected: 'в сети',
  disconnected: 'Нет связи',
  reconnecting: 'Переподключение…',
} as const

/**
 * Плавающая панель аккаунта для мобильной оболочки (Discord-style pill).
 *
 * Голосовые контролы — в `MobileVoiceFloatingTile`. Тап по pill → `/m/profile`.
 */
export function MobileUserPanel() {
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const voiceStage = useVoiceStage()
  const user = auth.user
  const homeBadge = useSyncStore((s) =>
    selectHomeNotificationBadge(s, auth.user?._id),
  )

  if (!user) return null
  if (voiceStage.stageFullscreen) return null

  const displayName = user.display_name ?? user.username
  const gatewayConnected = auth.gatewayState === 'connected'
  const gatewayReconnecting = auth.gatewayState === 'reconnecting'

  const statusLabel = gatewayConnected
    ? userStatusSubtitle(user)
    : gatewayLabels[auth.gatewayState]

  return (
    <div className="pointer-events-none absolute bottom-[calc(0.5rem+env(safe-area-inset-bottom))] left-2 right-2 z-50">
      <div className="pointer-events-auto">
        <div className="relative h-14 w-full">
          <div
            className="absolute top-1/2 right-0 left-6 flex h-10 -translate-y-1/2 items-center rounded-full bg-card pr-1.5 pl-11 shadow-lg ring-1 ring-shell-divider"
            aria-hidden
          />

          <Link
            to="/m/profile"
            className="absolute inset-y-0 left-0 z-10 flex min-w-0 items-center pr-12 text-left"
          >
            <UserAvatar
              user={user}
              className="size-14 shrink-0"
              fallbackClassName="size-14 text-base"
              showPresence
              presenceRingClassName="border-background"
            />
            <span className="min-w-0 flex-1 pl-2">
              <span className="flex min-w-0 items-center gap-0.5">
                <span className="truncate text-sm font-semibold leading-tight">
                  {displayName}
                </span>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
              </span>
              <span
                className={cn(
                  'mt-0.5 block truncate text-xs leading-tight',
                  gatewayConnected
                    ? 'text-muted-foreground'
                    : gatewayReconnecting
                      ? 'text-chart-2'
                      : 'text-destructive',
                )}
              >
                {statusLabel}
              </span>
            </span>
          </Link>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-1/2 right-1 z-20 size-9 -translate-y-1/2 rounded-full bg-background/60 hover:bg-background/80"
            title="Уведомления"
            aria-label="Уведомления"
            onClick={() => openSettings('notifications')}
          >
            <BellIcon className="size-5" />
            <NotificationBadge
              badge={homeBadge}
              className="absolute top-0 right-0"
            />
          </Button>
        </div>
      </div>
    </div>
  )
}
