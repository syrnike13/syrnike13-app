import { Link } from '@tanstack/react-router'
import { BellIcon, ChevronDownIcon } from '#/components/icons'

import {
  VoiceCameraStrip,
  VoiceScreenShareStrip,
} from '#/components/voice/voice-local-broadcast-strip'
import { VoiceConnectionStrip } from '#/components/voice/voice-connection-strip'
import { VoicePanelMediaBar } from '#/components/voice/voice-panel-media-bar'
import { VoiceMicSplitControl } from '#/components/voice/voice-mic-split-control'
import { VoiceSoundSplitControl } from '#/components/voice/voice-sound-split-control'
import { NotificationBadge } from '#/components/notifications/notification-badge'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { selectHomeNotificationBadge } from '#/features/notifications/notification-selectors'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useSyncStore } from '#/features/sync/sync-store'
import { useVoice } from '#/features/voice/voice-context'
import { isMicVisuallyMuted } from '#/features/voice/voice-mic-status'
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
 * Тап по pill открывает `/app/profile`. Колокольчик — настройки уведомлений.
 */
export function MobileUserPanel() {
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const voice = useVoice()
  const user = auth.user
  const homeBadge = useSyncStore((s) =>
    selectHomeNotificationBadge(s, auth.user?._id),
  )

  if (!user) return null
  if (voice.stageFullscreen) return null

  const displayName = user.display_name ?? user.username
  const inVoiceSession =
    voice.channelId != null &&
    (voice.status === 'connected' || voice.status === 'connecting')
  const inVoice = voice.status === 'connected'
  const gatewayConnected = auth.gatewayState === 'connected'
  const gatewayReconnecting = auth.gatewayState === 'reconnecting'
  const micMuted = isMicVisuallyMuted({
    inVoiceSession,
    micEnabled: voice.micEnabled,
    micPublishing: voice.micPublishing,
  })
  const soundOff = voice.deafened

  const statusLabel = gatewayConnected
    ? userStatusSubtitle(user)
    : gatewayLabels[auth.gatewayState]

  return (
    <div className="pointer-events-none absolute bottom-[calc(0.5rem+env(safe-area-inset-bottom))] left-2 right-2 z-50">
      <div className="pointer-events-auto flex flex-col gap-2 overflow-visible">
        {inVoiceSession ? (
          <div className="overflow-hidden rounded-2xl bg-card shadow-lg ring-1 ring-shell-divider">
            <VoiceScreenShareStrip />
            <VoiceCameraStrip />
            <VoiceConnectionStrip />
            <VoicePanelMediaBar />
            <div className="flex items-center justify-end gap-1 border-t border-shell-divider px-2 py-1.5">
              <VoiceMicSplitControl
                surface="panel"
                inVoice={inVoice}
                connecting={voice.status === 'connecting'}
                micMuted={micMuted}
                onToggleMic={voice.toggleMic}
              />
              <VoiceSoundSplitControl
                surface="panel"
                inVoice={inVoice}
                connecting={voice.status === 'connecting'}
                soundOff={soundOff}
                onToggleDeafen={voice.toggleDeafen}
              />
            </div>
          </div>
        ) : null}

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
                      ? 'text-amber-500'
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
