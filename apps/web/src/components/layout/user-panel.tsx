import { useState } from 'react'
import { SettingsIcon } from '#/components/icons'
import {
  VoiceCameraStrip,
  VoiceScreenShareStrip,
} from '#/components/voice/voice-local-broadcast-strip'
import { VoiceConnectionStrip } from '#/components/voice/voice-connection-strip'
import { VoicePanelMediaBar } from '#/components/voice/voice-panel-media-bar'
import { VoiceMicSplitControl } from '#/components/voice/voice-mic-split-control'
import { VoiceSoundSplitControl } from '#/components/voice/voice-sound-split-control'
import { CurrentUserProfileMenu } from '#/components/user/current-user-profile-menu'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useVoice } from '#/features/voice/voice-context'
import { isMicVisuallyMuted } from '#/features/voice/voice-mic-status'
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
  disconnected: 'Нет связи',
  reconnecting: 'Переподключение…',
} as const

const userPanelControlButtonClass =
  'size-9 shrink-0 rounded-md bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'

export function UserPanel() {
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const voice = useVoice()
  const [menuOpen, setMenuOpen] = useState(false)
  const [globalProfileOpen, setGlobalProfileOpen] = useState(false)
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
        {inVoiceSession ? (
          <>
            <VoiceScreenShareStrip />
            <VoiceCameraStrip />
            <VoiceConnectionStrip />
            <VoicePanelMediaBar />
          </>
        ) : null}

        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverAnchor asChild>
            <div
              className={cn(
                'flex w-full items-center gap-2.5 px-2.5',
                FLOATING_BAR_HEIGHT_CLASS,
              )}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="group/profile flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md py-1 pr-1 text-left hover:bg-white/5"
                >
                  <UserAvatar
                    user={user}
                    className="size-9 shrink-0"
                    fallbackClassName="size-9"
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
                          gatewayConnected
                            ? 'text-muted-foreground'
                            : gatewayReconnecting
                              ? 'text-amber-400/90'
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

              <div className="flex shrink-0 items-center gap-1">
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

                <Button
                  variant="ghost"
                  size="icon"
                  className={userPanelControlButtonClass}
                  title="Настройки"
                  onClick={() => openSettings('account')}
                >
                  <SettingsIcon className="size-4" />
                </Button>
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={16}
            className="z-[200] w-[min(300px,calc(100vw-1rem))] overflow-hidden border-0 bg-card p-0 text-foreground shadow-xl ring-1 ring-shell-divider"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <CurrentUserProfileMenu
              user={user}
              onClose={() => setMenuOpen(false)}
              onOpenGlobalProfile={() => {
                setMenuOpen(false)
                setGlobalProfileOpen(true)
              }}
            />
          </PopoverContent>
        </Popover>

        <UserGlobalProfileDialog
          user={user}
          open={globalProfileOpen}
          onOpenChange={setGlobalProfileOpen}
        />
      </div>
    </div>
  )
}
