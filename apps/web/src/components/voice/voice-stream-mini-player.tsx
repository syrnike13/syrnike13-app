import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  ChevronLeftIcon,
  MonitorXIcon,
  Settings2Icon,
  Volume2Icon,
  VolumeXIcon,
} from '#/components/icons'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { Slider } from '@syrnike13/ui/primitives/slider'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { ScreenShareQualitySections } from '#/components/voice/voice-screen-share-quality'
import {
  voiceStagePopoverContentClass,
  voiceStagePopoverSeparatorClass,
} from '#/components/voice/voice-stage-popover-styles'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import {
  formatUserVolumeLabel,
  useVoiceListenerStore,
  voiceListenerStore,
  VOICE_USER_VOLUME_MAX,
} from '#/features/voice/voice-listener-store'
import { useSpringCornerDrag } from '#/hooks/use-spring-corner-drag'
import {
  clampMiniPlayerPosition,
  miniPlayerCornerPosition,
  miniPlayerVisible,
  miniPlayerWidth,
  MINI_PLAYER_CORNER_KEY,
  MINI_PLAYER_WIDTH_KEY,
  selectMiniPlayerStream,
} from '#/features/voice/stream-mini-player'
import { cn } from '#/lib/utils'
import { VoiceStageVideo } from './voice-stage-video'

function readWidth() {
  try {
    return Number(window.localStorage.getItem(MINI_PLAYER_WIDTH_KEY)) || 320
  } catch {
    return 320
  }
}

const miniIconButtonClass =
  'pointer-events-auto flex size-8 shrink-0 items-center justify-center rounded-md text-on-media/80 transition-colors hover:bg-on-media/15 hover:text-on-media focus-visible:outline focus-visible:outline-ring data-[state=open]:bg-on-media/15 data-[state=open]:text-on-media'

function MiniControl({
  label,
  children,
  onClick,
}: {
  label: string
  children: ReactNode
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-mini-control
          aria-label={label}
          className={miniIconButtonClass}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function MiniStreamVolumeSection({ userId }: { userId: string }) {
  const t = useTranslations('voice')
  const muted = useVoiceListenerStore((s) => s.getStreamMuted(userId))
  const volume = useVoiceListenerStore((s) => s.getStreamVolume(userId))
  return (
    <>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent/70">
        <span>{t('actions.muteStream')}</span>
        <input
          type="checkbox"
          className="size-4 rounded border-input accent-primary"
          checked={muted}
          onChange={(event) =>
            voiceListenerStore.setStreamMuted(userId, event.target.checked)
          }
        />
      </label>
      <div className="px-2 pt-1 pb-2">
        <div className="pb-2 text-xs text-muted-foreground">
          {t('actions.streamVolume')}
        </div>
        <div className="flex items-center gap-2">
          <Slider
            className="flex-1"
            min={0}
            max={VOICE_USER_VOLUME_MAX}
            step={0.1}
            value={[muted ? 0 : volume]}
            onValueChange={([next]) => {
              if (muted && next > 0) {
                voiceListenerStore.setStreamMuted(userId, false)
              }
              voiceListenerStore.setStreamVolume(userId, next)
            }}
            aria-label={t('actions.streamVolume')}
          />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {formatUserVolumeLabel(muted ? 0 : volume)}
          </span>
        </div>
      </div>
    </>
  )
}

function MiniStreamSettings({
  remoteUserId,
  showOwnQuality,
  onOpenChange,
}: {
  /** Чей стрим смотрим (для громкости); null — показан свой стрим. */
  remoteUserId: string | null
  /** Пользователь сам стримит — даём менять разрешение и FPS. */
  showOwnQuality: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('voice')
  if (!remoteUserId && !showOwnQuality) return null
  return (
    <Popover onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-mini-control
              aria-label={t('stream.settings')}
              className={miniIconButtonClass}
            >
              <Settings2Icon className="size-[1.125rem]" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('stream.settings')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        data-mini-control
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          voiceStagePopoverContentClass,
          'z-[510] max-h-[min(70vh,32rem)] w-64 overflow-y-auto',
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {remoteUserId ? <MiniStreamVolumeSection userId={remoteUserId} /> : null}
        {remoteUserId && showOwnQuality ? (
          <div className={cn(voiceStagePopoverSeparatorClass, 'my-1.5')} />
        ) : null}
        {showOwnQuality ? (
          <>
            <p className="px-2 pt-1 text-sm font-semibold text-foreground">
              {t('stream.quality')}
            </p>
            <ScreenShareQualitySections />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function MiniStreamMuteButton({ userId }: { userId: string }) {
  const t = useTranslations('voice')
  const muted = useVoiceListenerStore((s) => s.getStreamMuted(userId))
  const volume = useVoiceListenerStore((s) => s.getStreamVolume(userId))
  const silent = muted || volume === 0
  return (
    <MiniControl
      label={
        muted
          ? t('actions.enableStreamSound')
          : t('actions.disableStreamSound')
      }
      onClick={() => voiceListenerStore.setStreamMuted(userId, !muted)}
    >
      {silent ? (
        <VolumeXIcon className="size-[1.125rem]" />
      ) : (
        <Volume2Icon className="size-[1.125rem]" />
      )}
    </MiniControl>
  )
}

export function VoiceStreamMiniPlayer() {
  const t = useTranslations('voice')
  const voice = useVoiceStage()
  const voiceMedia = useVoiceMedia()
  const ownStreamActive =
    voiceMedia.screenShareEnabled || voiceMedia.screenShareStarting
  const auth = useAuth()
  const users = useSyncStore((state) => state.users)
  const channel = useSyncStore((state) =>
    voice.stageChannelId ? state.channels[voice.stageChannelId] : undefined,
  )
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const [requestedWidth, setRequestedWidth] = useState(readWidth)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const resize = useRef<{
    pointerId: number
    x: number
    y: number
    width: number
  } | null>(null)
  const suppressResizeClick = useRef(false)
  const width = miniPlayerWidth(requestedWidth, viewport)
  const height = (width * 9) / 16
  const anchor = useSpringCornerDrag({
    storageKey: MINI_PLAYER_CORNER_KEY,
    fallback: 'bottom-left',
    cornerPosition: (corner) =>
      miniPlayerCornerPosition(corner, width, viewport),
    clamp: (point) => clampMiniPlayerPosition(point.x, point.y, width, viewport),
    size: { width, height },
  })
  useEffect(() => {
    const update = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const item = selectMiniPlayerStream(
    voice.streamMediaItems,
    voice.viewedRemoteScreenIds,
    voice.focusedMediaId,
  )
  const visible = miniPlayerVisible({
    hasStream: item !== null,
    sessionChannelId: voice.stageChannelId,
    routeChannelId: params.channelId,
    stageMounted: voice.mountedStageChannelIds.includes(
      voice.stageChannelId ?? '',
    ),
    popoutOpen: voice.popoutWindow !== null && !voice.popoutWindow.closed,
    fullscreen: voice.stageFullscreen,
  })
  if (!visible || !item || !voice.stageChannelId) return null
  const right = anchor.corner.endsWith('right')
  const bottom = anchor.corner.startsWith('bottom')
  const channelName =
    channel && 'name' in channel ? channel.name : t('channel')
  const streamerName = voiceParticipantDisplayName(
    item.userId,
    users,
    auth.user,
    t,
  )
  const isControl = (target: EventTarget) =>
    target instanceof Element && target.closest('[data-mini-control]') !== null
  const returnToChannel = () => {
    if (anchor.consumeSuppressedClick() || suppressResizeClick.current) {
      suppressResizeClick.current = false
      return
    }
    if (!voice.stageChannelId) return
    voice.setFocusedMediaId(item.id)
    void navigate({
      to: '/app/c/$channelId',
      params: { channelId: voice.stageChannelId },
      search: { m: undefined },
    })
  }
  const finishResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    try {
      window.localStorage.setItem(MINI_PLAYER_WIDTH_KEY, String(width))
    } catch {
      /* Storage may be unavailable. */
    }
    event.stopPropagation()
  }
  const chromeVisibility = cn(
    'pointer-events-none absolute inset-x-0 flex items-center gap-1 px-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100',
    (settingsOpen || anchor.dragging) && 'opacity-100',
  )
  return (
    <TooltipProvider>
      <section
        ref={anchor.ref}
        aria-label={t('miniPlayer.label')}
        className="group fixed top-0 left-0 z-[500] touch-none select-none will-change-transform"
        style={{ width, aspectRatio: '16 / 9' }}
        onClick={(event) => {
          if (isControl(event.target)) return
          returnToChannel()
        }}
        onPointerDown={(event) => {
          if (isControl(event.target)) return
          anchor.onPointerDown(event)
        }}
        onPointerMove={anchor.onPointerMove}
        onPointerUp={anchor.onPointerUp}
        onPointerCancel={anchor.onPointerCancel}
      >
        <div
          className={cn(
            'relative size-full overflow-hidden rounded-lg bg-media-backdrop text-on-media shadow-xl ring-1 ring-shell-divider transition-[transform,box-shadow] duration-200 ease-out motion-reduce:transition-none',
            anchor.dragging && 'scale-[1.03] shadow-2xl',
          )}
        >
          <button
            type="button"
            className={cn(
              'absolute inset-0 flex items-center justify-center focus-visible:outline focus-visible:outline-ring',
              anchor.dragging ? 'cursor-grabbing' : 'cursor-pointer',
            )}
            aria-label={t('miniPlayer.back')}
          >
            {item.track ? (
              <VoiceStageVideo
                track={item.track}
                mediaId={item.id}
                fit="contain"
              />
            ) : (
              <span className="text-sm text-on-media/70">
                {item.error
                  ? t('stream.unavailable')
                  : t('stream.connecting')}
              </span>
            )}
          </button>

          {/* Верх: тень сверху рассеивается вниз, название канала. */}
          <div
            className={cn(
              chromeVisibility,
              'top-0 h-16 items-start bg-linear-to-b from-media-backdrop/75 via-media-backdrop/35 to-transparent pt-1.5',
            )}
          >
            <button
              type="button"
              data-mini-control
              aria-label={t('miniPlayer.back')}
              title={channelName}
              className="pointer-events-auto flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pr-2 pl-0.5 text-sm font-semibold text-on-media/90 transition-colors hover:bg-on-media/15 hover:text-on-media focus-visible:outline focus-visible:outline-ring"
              onClick={returnToChannel}
            >
              <ChevronLeftIcon className="size-5 shrink-0" />
              <span className="truncate">{channelName}</span>
            </button>
          </div>

          {/* Низ: тень снизу рассеивается вверх, ник и управление. */}
          <div
            className={cn(
              chromeVisibility,
              'bottom-0 h-16 items-end bg-linear-to-t from-media-backdrop/80 via-media-backdrop/40 to-transparent pb-1.5',
            )}
          >
            <span className="min-w-0 flex-1 truncate pb-1.5 pl-1 text-sm font-semibold text-on-media drop-shadow">
              {streamerName}
            </span>
            {!item.isLocal ? (
              <MiniStreamMuteButton userId={item.userId} />
            ) : null}
            <MiniStreamSettings
              remoteUserId={item.isLocal ? null : item.userId}
              showOwnQuality={ownStreamActive}
              onOpenChange={setSettingsOpen}
            />
            {item.isLocal ? (
              <MiniControl
                label={t('actions.stopStream')}
                onClick={voiceMedia.toggleScreenShare}
              >
                <MonitorXIcon className="size-[1.125rem]" />
              </MiniControl>
            ) : (
              <MiniControl
                label={t('actions.stopWatching')}
                onClick={() => voice.setStageMediaSubscribed(item.id, false)}
              >
                <MonitorXIcon className="size-[1.125rem]" />
              </MiniControl>
            )}
          </div>
        </div>

        {/* Невидимая зона изменения размера во внутреннем углу. */}
        <button
          type="button"
          data-mini-control
          aria-label={t('miniPlayer.resize')}
          className="absolute size-4 focus-visible:outline focus-visible:outline-ring"
          style={{
            [right ? 'left' : 'right']: 0,
            [bottom ? 'top' : 'bottom']: 0,
            cursor: right !== bottom ? 'nesw-resize' : 'nwse-resize',
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.stopPropagation()
            event.currentTarget.setPointerCapture(event.pointerId)
            suppressResizeClick.current = true
            resize.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              width,
            }
          }}
          onPointerMove={(event) => {
            const start = resize.current
            if (!start || start.pointerId !== event.pointerId) return
            event.stopPropagation()
            const dx = (event.clientX - start.x) * (right ? -1 : 1)
            const dy = ((event.clientY - start.y) * (bottom ? -1 : 1) * 16) / 9
            setRequestedWidth(
              miniPlayerWidth(
                start.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy),
                viewport,
              ),
            )
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onClick={(event) => {
            event.stopPropagation()
            suppressResizeClick.current = false
          }}
          onKeyDown={(event) => {
            if (
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                event.key,
              )
            )
              return
            event.preventDefault()
            const next = miniPlayerWidth(
              width +
                (event.key === 'ArrowRight' || event.key === 'ArrowUp'
                  ? 16
                  : -16),
              viewport,
            )
            setRequestedWidth(next)
            try {
              window.localStorage.setItem(MINI_PLAYER_WIDTH_KEY, String(next))
            } catch {
              /* Storage may be unavailable. */
            }
          }}
        />
      </section>
    </TooltipProvider>
  )
}
