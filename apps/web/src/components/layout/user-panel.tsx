import { useState } from 'react'
import { SettingsIcon, TelegramIcon } from '#/components/icons'
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
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { isMicVisuallyMuted } from '#/features/voice/voice-mic-status'
import { APP_LOGO_SRC } from '#/lib/brand'
import { userStatusSubtitle } from '#/lib/presence'
import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import { FLOATING_BAR_HEIGHT_CLASS } from '#/components/layout/shell-chrome'
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

const TELEGRAM_CHANNEL_URL = 'https://t.me/+oF1TAWZ2yyQwMDcy'

type UserPanelProps = {
  telegramPromoVisible: boolean
  onDismissTelegramPromo: () => void
}

export function UserPanel({
  telegramPromoVisible,
  onDismissTelegramPromo,
}: UserPanelProps) {
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const voiceSession = useVoiceSession()
  const voiceStage = useVoiceStage()
  const [menuOpen, setMenuOpen] = useState(false)
  const [globalProfileOpen, setGlobalProfileOpen] = useState(false)
  const [telegramPromoOpen, setTelegramPromoOpen] = useState(false)
  const user = auth.user
  if (!user) return null
  if (voiceStage.stageFullscreen) return null

  const displayName = user.display_name ?? user.username
  const usernameLabel = `@${user.username}`
  const inVoiceSession =
    voiceSession.channelId != null &&
    (voiceSession.status === 'connected' || voiceSession.status === 'connecting')
  const inVoice = voiceSession.status === 'connected'
  const gatewayConnected = auth.gatewayState === 'connected'
  const gatewayReconnecting = auth.gatewayState === 'reconnecting'
  const micMuted = isMicVisuallyMuted({
    inVoiceSession,
    micEnabled: voiceSession.micEnabled,
    micPublishing: voiceSession.micPublishing,
    deafened: voiceSession.deafened,
  })
  const soundOff = voiceSession.deafened

  const statusLabel = gatewayConnected
    ? userStatusSubtitle(user)
    : gatewayLabels[auth.gatewayState]

  return (
    <div
      className="relative"
      onPointerOver={(event) => {
        const target = event.target as Element
        setTelegramPromoOpen(
          Boolean(target.closest('[data-telegram-promo-hover]')),
        )
      }}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) {
          setTelegramPromoOpen(false)
        }
      }}
      onFocusCapture={(event) => {
        const target = event.target as Element
        if (target.closest('[data-telegram-promo-hover]')) {
          setTelegramPromoOpen(true)
        }
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setTelegramPromoOpen(false)
        }
      }}
    >
      <FloatingBarShell
        className="pointer-events-auto relative z-10"
        surfaceClassName="flex flex-col"
      >
        {telegramPromoVisible ? (
          <div aria-hidden="true" className="h-13 shrink-0" />
        ) : null}

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
                              ? 'text-chart-2/90'
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
                  connecting={voiceSession.status === 'connecting'}
                  micMuted={micMuted}
                  onToggleMic={voiceSession.toggleMic}
                />

                <VoiceSoundSplitControl
                  surface="panel"
                  inVoice={inVoice}
                  connecting={voiceSession.status === 'connecting'}
                  soundOff={soundOff}
                  onToggleDeafen={voiceSession.toggleDeafen}
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
      </FloatingBarShell>

      {telegramPromoVisible ? (
        <div
          data-telegram-promo-hover=""
          className={cn(
            'absolute inset-x-0 bottom-14 z-20 grid overflow-hidden rounded-t-[10px] border-x border-t border-shell-divider',
            'telegram-promo-surface bg-secondary bg-linear-to-r from-sidebar-ring/25 via-accent/60 to-sidebar-ring/15 text-foreground',
            'transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]',
            telegramPromoOpen
              ? 'grid-rows-[52px_1fr]'
              : 'grid-rows-[52px_0fr]',
            'motion-reduce:transition-none',
          )}
        >
          <button
            type="button"
            className="relative h-13 text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-expanded={telegramPromoOpen}
            aria-controls="telegram-promo-details"
            aria-label="Подпишись на наш Telegram"
            onClick={() => setTelegramPromoOpen(true)}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-sidebar-ring/70 to-transparent"
            />

            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center gap-3 px-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold leading-4">
                  Подпишись на наш Telegram
                </span>
                <span
                  className={cn(
                    'grid transition-[grid-template-rows,opacity] duration-150 ease-out',
                    telegramPromoOpen
                      ? 'grid-rows-[0fr] opacity-0'
                      : 'grid-rows-[1fr] opacity-100',
                    'motion-reduce:transition-none',
                  )}
                >
                  <span className="min-h-0 overflow-hidden">
                    <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
                      Новости проекта без лишнего шума
                    </span>
                  </span>
                </span>
              </span>

              <span className="telegram-promo-icon relative flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-ring/80 text-primary-foreground ring-1 ring-sidebar-ring/60">
                <TelegramIcon aria-hidden="true" className="size-[18px]" />
              </span>
            </span>
          </button>

          <div className="min-h-0 overflow-hidden">
            <div
              id="telegram-promo-details"
              aria-hidden={!telegramPromoOpen}
              className="relative isolate flex h-[104px] flex-col justify-between gap-2 overflow-hidden px-3 pb-3 pt-3"
            >
              <img
                src={APP_LOGO_SRC}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="pointer-events-none absolute -bottom-3 -left-4 size-20 rotate-6 object-contain [image-rendering:pixelated]"
              />
              <p className="relative z-10 max-w-[250px] text-sm font-semibold leading-5 text-foreground">
                Спойлеры, анонсы и.. Сырники!
              </p>
              <div className="relative z-10 flex items-center gap-2 pl-12">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  tabIndex={telegramPromoOpen ? 0 : -1}
                  className="min-w-0 flex-1 px-2 text-xs"
                  onClick={onDismissTelegramPromo}
                >
                  Я уже подписан
                </Button>
                <Button
                  asChild
                  size="sm"
                  className="min-w-0 flex-1 bg-foreground px-2 text-xs text-background hover:bg-foreground/90"
                >
                  <a
                    href={TELEGRAM_CHANNEL_URL}
                    target="_blank"
                    rel="noreferrer"
                    tabIndex={telegramPromoOpen ? 0 : -1}
                  >
                    В Telegram
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
