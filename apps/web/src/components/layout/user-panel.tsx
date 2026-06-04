import { useNavigate } from '@tanstack/react-router'
import {
  HeadphoneOffIcon,
  HeadphonesIcon,
  LogOutIcon,
  MicIcon,
  MicOffIcon,
  SettingsIcon,
} from 'lucide-react'
import { VoiceConnectionStrip } from '#/components/voice/voice-connection-strip'
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
import { presenceLabel } from '#/lib/presence'
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
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()
  const voice = useVoice()
  const user = auth.user
  if (!user) return null

  const displayName = user.display_name ?? user.username
  const inVoiceSession =
    voice.channelId != null &&
    (voice.status === 'connected' || voice.status === 'connecting')
  const inVoice = voice.status === 'connected'
  const gatewayOnline = auth.gatewayState === 'connected'
  const micMuted = !voice.micEnabled
  const soundOff = voice.deafened

  const statusLabel = inVoice
    ? micMuted
      ? soundOff
        ? 'Глухой режим'
        : 'Микрофон выключен'
      : 'В голосовом канале'
    : soundOff
      ? 'Звук выключен'
      : micMuted
        ? 'Микрофон выключен'
        : gatewayOnline
          ? presenceLabel(user)
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
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md py-1 pr-1 text-left hover:bg-white/5"
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
                  <p
                    className={cn(
                      'truncate text-xs leading-4',
                      gatewayOnline || inVoice
                        ? 'text-muted-foreground'
                        : 'text-destructive/80',
                    )}
                  >
                    {statusLabel}
                  </p>
                </div>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-52 p-1">
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2 px-2 font-normal"
                onClick={() => openSettings('account')}
              >
                <SettingsIcon className="size-4" />
                Настройки
              </Button>
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2 px-2 font-normal"
                onClick={() => openSettings('voice')}
              >
                <HeadphonesIcon className="size-4" />
                Голос и видео
              </Button>
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2 px-2 font-normal text-destructive hover:text-destructive"
                onClick={() => {
                  void auth.logout().then(() => navigate({ to: '/login' }))
                }}
              >
                <LogOutIcon className="size-4" />
                Выйти
              </Button>
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
              title={
                inVoice
                  ? micMuted
                    ? 'Включить микрофон'
                    : 'Выключить микрофон'
                  : micMuted
                    ? 'Микрофон выключен (применится при входе в голос)'
                    : 'Выключить микрофон до входа в голос'
              }
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
