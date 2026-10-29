import { useTranslations } from '@syrnike13/ui/i18n'
import { useEffect, useRef, useState } from 'react'
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
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { SidebarMenuButton } from '@syrnike13/ui/primitives/sidebar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { isMicVisuallyMuted } from '#/features/voice/voice-mic-status'
import { userStatusSubtitle } from '#/lib/presence'
import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import { FLOATING_BAR_HEIGHT_CLASS } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

const gatewayStatusKeys = {
  idle: 'status.idle',
  connecting: 'status.connecting',
  connected: 'status.connected',
  disconnected: 'status.disconnected',
  reconnecting: 'status.reconnecting',
} as const

const TELEGRAM_CHANNEL_URL = 'https://t.me/+oF1TAWZ2yyQwMDcy'

type UserPanelProps = {
  telegramPromoVisible: boolean
  onDismissTelegramPromo: () => void
  /** Фактическая высота панели (строка + voice/telegram блоки). */
  onHeightChange?: (heightPx: number) => void
}

export function UserPanel({
  telegramPromoVisible,
  onDismissTelegramPromo,
  onHeightChange,
}: UserPanelProps) {
  const t = useTranslations('layout.user')
  const tc = useTranslations('chat')
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const voiceSession = useVoiceSession()
  const voiceStage = useVoiceStage()
  const rootRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [globalProfileOpen, setGlobalProfileOpen] = useState(false)
  const [telegramPromoOpen, setTelegramPromoOpen] = useState(false)
  const user = auth.user
  const hidden = !user || voiceStage.stageFullscreen

  useEffect(() => {
    if (!onHeightChange) return
    if (hidden) {
      onHeightChange(0)
      return
    }

    const element = rootRef.current
    if (!element) return

    const update = () =>
      onHeightChange(Math.ceil(element.getBoundingClientRect().height))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [hidden, onHeightChange])

  if (hidden || !user) return null

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
    ? userStatusSubtitle(user, tc)
    : t(gatewayStatusKeys[auth.gatewayState])

  return (
    <div
      ref={rootRef}
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
          <div
            className={cn(
              'flex w-full items-center gap-2 px-3',
              FLOATING_BAR_HEIGHT_CLASS,
            )}
          >
            <PopoverTrigger
              render={
                // eslint-disable-next-line design/no-restyle -- the profile button's left inset is half the right one, so the avatar edge reads as even
                <SidebarMenuButton
                  size="lg"
                  data-avatar-hover-scope=""
                  className="min-w-0 flex-1 pl-1 text-foreground"
                />
              }
            >
              <UserAvatar
                user={user}
                className="size-8 shrink-0"
                fallbackClassName="size-8"
                hoverScope="parent"
                showPresence
              />
              <div className="min-w-0 flex-1 overflow-hidden">
                <p className="truncate text-base font-medium leading-4.5">
                  {displayName}
                </p>
                <div className="relative h-3.25 overflow-hidden">
                  <p
                    className={cn(
                      'truncate text-xs font-medium leading-3.25 transition duration-200 ease-out',
                      'group-hover/menu-button:-translate-y-full group-hover/menu-button:opacity-0',
                      gatewayConnected
                        ? 'text-muted-foreground'
                        : gatewayReconnecting
                          ? 'text-warning/90'
                          : 'text-destructive/80',
                    )}
                  >
                    {statusLabel}
                  </p>
                  <p
                    className={cn(
                      'absolute inset-x-0 top-0 truncate text-xs font-medium leading-3.25 text-muted-foreground',
                      'translate-y-full opacity-0 transition duration-200 ease-out',
                      'group-hover/menu-button:translate-y-0 group-hover/menu-button:opacity-100',
                    )}
                  >
                    {usernameLabel}
                  </p>
                </div>
              </div>
            </PopoverTrigger>

            <div className="flex shrink-0 items-center gap-2">
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
                className="text-muted-foreground"
                title={t('settings')}
                aria-label={t('settings')}
                onClick={() => openSettings('account')}
              >
                <SettingsIcon className="size-5" />
              </Button>
            </div>
          </div>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="z-200 w-user-panel-popover overflow-hidden p-0"
            initialFocus={false}
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
            'absolute inset-x-0 bottom-full translate-y-13 z-20 grid overflow-hidden rounded-t-lg border-x border-t border-shell-divider',
            'telegram-promo-surface bg-secondary bg-linear-to-r from-sidebar-ring/25 via-accent/60 to-sidebar-ring/15 text-foreground',
            'motion-rows duration-200 ease-out-expo',
            telegramPromoOpen
              ? 'promo-open-rows'
              : 'promo-closed-rows',
            'motion-reduce:transition-none',
          )}
        >
          {/* eslint-disable-next-line design/no-lookalike -- promo banner card */}
          <button
            type="button"
            className="relative h-13 text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-expanded={telegramPromoOpen}
            aria-controls="telegram-promo-details"
            aria-label={t('telegram.title')}
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
                  {t('telegram.title')}
                </span>
                <span
                  className={cn(
                    'grid motion-rows transition-opacity duration-150 ease-out',
                    telegramPromoOpen
                      ? 'collapsed-rows opacity-0'
                      : 'expanded-rows opacity-100',
                    'motion-reduce:transition-none',
                  )}
                >
                  <span className="min-h-0 overflow-hidden">
                    <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
                      {t('telegram.subtitle')}
                    </span>
                  </span>
                </span>
              </span>

              <span className="telegram-promo-icon relative flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-ring/80 text-primary-foreground ring-1 ring-sidebar-ring/60">
                <TelegramIcon aria-hidden="true" className="size-4.5" />
              </span>
            </span>
          </button>

          <div className="min-h-0 overflow-hidden">
            <div
              id="telegram-promo-details"
              aria-hidden={!telegramPromoOpen}
              className="relative isolate flex h-26 flex-col justify-between gap-2 overflow-hidden px-3 pb-3 pt-3"
            >
              <img
                src="/telegram-promo-cat.png"
                alt=""
                aria-hidden="true"
                draggable={false}
                className="pointer-events-none absolute -bottom-10 -left-8 size-30 rotate-6 object-contain pixelated"
              />
              <p className="relative z-10 max-w-62.5 text-sm font-semibold leading-5 text-foreground">
                {t('telegram.headline')}
              </p>
              <div className="relative z-10 flex items-center gap-2 pl-12">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  tabIndex={telegramPromoOpen ? 0 : -1}
                  className="min-w-0 flex-1"
                  onClick={onDismissTelegramPromo}
                >
                  {t('telegram.dismiss')}
                </Button>
                <a
                  href={TELEGRAM_CHANNEL_URL}
                  target="_blank"
                  rel="noreferrer"
                  tabIndex={telegramPromoOpen ? 0 : -1}
                  className={cn(
                    buttonVariants({ variant: 'secondary', size: 'sm' }),
                    'min-w-0 flex-1',
                  )}
                >
                  {t('telegram.open')}
                </a>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
