import { useState } from 'react'
import {
  HeadphoneOffIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  SettingsIcon,
} from 'lucide-react'
import { VoiceConnectionStrip } from '#/components/voice/voice-connection-strip'
import { CurrentUserProfileMenu } from '#/components/user/current-user-profile-menu'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useVoice } from '#/features/voice/voice-provider'
import {
  isMicVisuallyMuted,
  micControlTitle,
} from '#/features/voice/voice-mic-status'
import { userStatusSubtitle } from '#/lib/presence'
import { USER_PANEL_SPAN_WIDTH } from '#/components/layout/left-sidebar-stack'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_HEIGHT_CLASS,
  floatingBarShellClass,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

const gatewayLabels = {
  idle: 'Не подключён',
  connecting: 'Подключение…',
  connected: 'в сети',
  disconnected: 'Отключён',
} as const

export function UserPanel() {
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const voice = useVoice()
  const [menuOpen, setMenuOpen] = useState(false)
  const user = auth.user
  if (!user) return null
  if (voice.stageFullscreen) return null

  const displayName = user.display_name ?? user.username
  const usernameLabel = `@${user.username}`
  const inVoiceSession =
    voice.channelId != null &&
    (voice.status === 'connected' || voice.status === 'connecting')
  const inVoice = voice.status === 'connected'
  const gatewayConnected = auth.gatewayState === 'connected'
  const micMuted = isMicVisuallyMuted({
    inVoiceSession,
    micEnabled: voice.micEnabled,
    micPublishing: voice.micPublishing,
  })
  const soundOff = voice.deafened

  const statusLabel = inVoice
    ? voice.micIssue
      ? voice.micIssue.label
      : micMuted
        ? soundOff
          ? 'Глухой режим'
          : 'Микрофон выключен'
        : 'В голосовом канале'
    : soundOff
      ? 'Звук выключен'
      : micMuted
        ? 'Микрофон выключен'
        : gatewayConnected
          ? userStatusSubtitle(user)
          : gatewayLabels[auth.gatewayState]

  return (
    <div
      className={cn(
        'pointer-events-none absolute left-2 z-50',
        FLOATING_BAR_BOTTOM_CLASS,
      )}
      style={{ width: USER_PANEL_SPAN_WIDTH }}
    >
      <div
        className={cn(
          'pointer-events-auto flex w-full flex-col overflow-hidden',
          floatingBarShellClass,
          'bg-secondary text-secondary-foreground',
        )}
      >
        {inVoiceSession ? <VoiceConnectionStrip /> : null}

        <div
          className={cn(
            'flex w-full items-center gap-2 px-2',
            FLOATING_BAR_HEIGHT_CLASS,
          )}
        >
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="group/profile flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md py-1 pr-1 text-left hover:bg-white/5"
              >
                <UserAvatar
                  user={user}
                  className="size-8 shrink-0"
                  fallbackClassName="size-8"
                  showPresence
                />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <p className="truncate text-sm font-semibold leading-4">
                    {displayName}
                  </p>
                  <div className="relative h-4 overflow-hidden">
                    <p
                      className={cn(
                        'truncate text-xs leading-4 transition-[transform,opacity] duration-200 ease-out',
                        'group-hover/profile:-translate-y-full group-hover/profile:opacity-0',
                        gatewayConnected || inVoice
                          ? 'text-muted-foreground'
                          : 'text-destructive/80',
                      )}
                    >
                      {statusLabel}
                    </p>
                    <p
                      className={cn(
                        'absolute inset-x-0 top-0 truncate text-xs leading-4 text-muted-foreground',
                        'translate-y-full opacity-0 transition-[transform,opacity] duration-200 ease-out',
                        'group-hover/profile:translate-y-0 group-hover/profile:opacity-100',
                      )}
                    >
                      {usernameLabel}
                    </p>
                  </div>
                </div>
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={16}
              style={{ width: USER_PANEL_SPAN_WIDTH }}
              className="z-[200] max-w-[calc(100vw-1rem)] overflow-hidden border-0 bg-card p-0 text-foreground shadow-xl ring-1 ring-shell-divider"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <CurrentUserProfileMenu
                user={user}
                onClose={() => setMenuOpen(false)}
              />
            </PopoverContent>
          </Popover>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 shrink-0 rounded-md bg-[#35373c] hover:bg-[#3f4147]',
                micMuted && 'text-destructive',
              )}
              title={micControlTitle({
                inVoice,
                micMuted,
                micIssue: voice.micIssue,
              })}
              disabled={voice.status === 'connecting'}
              onClick={voice.toggleMic}
            >
              {micMuted ? (
                <MicOffIcon className="size-4" />
              ) : (
                <MicIcon className="size-4" />
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 shrink-0 rounded-md bg-[#35373c] hover:bg-[#3f4147]',
                soundOff && 'text-destructive',
              )}
              title={
                inVoice
                  ? soundOff
                    ? 'Включить звук'
                    : 'Отключить звук'
                  : soundOff
                    ? 'Звук выключен (применится при входе в голос)'
                    : 'Отключить звук до входа в голос'
              }
              disabled={voice.status === 'connecting'}
              onClick={voice.toggleDeafen}
            >
              {soundOff ? (
                <HeadphoneOffIcon className="size-4" />
              ) : (
                <HeadphonesIcon className="size-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-md hover:bg-white/5"
              title="Настройки"
              onClick={() => openSettings('account')}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
