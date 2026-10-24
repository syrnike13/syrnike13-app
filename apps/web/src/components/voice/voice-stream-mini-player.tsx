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
  LogOutIcon,
  MonitorXIcon,
  Settings2Icon,
  Volume2Icon,
  VolumeXIcon,
} from '#/components/icons'
import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { ScreenShareQualitySections } from '#/components/voice/voice-screen-share-quality'
import {
  voiceStagePopoverContentClass,
} from '#/components/voice/voice-stage-popover-styles'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import {
  formatUserVolumeLabel,
  streamVolumeFromPercent,
  streamVolumeToPercent,
  VOICE_VOLUME_PERCENT_MAX,
  voiceListenerStore,
  useVoiceListenerStore,
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
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import type { ActivityInstance } from '@syrnike13/api-types/gateway-schema'
import type { ActivityApplication } from '#/features/activities/activity-api'
import { ActivityFrame } from '#/features/activities/activity-frame'
import {
  activityStageItemId,
  isActivityStageItemId,
} from '#/features/activities/activity-stage'
import {
  activityStore,
  isActivityParticipant,
} from '#/features/activities/activity-store'
import {
  useActivityApplication,
  useActivityInstance,
} from '#/features/activities/use-activities'
import { VoiceStageVideo } from './voice-stage-video'

function readWidth() {
  try {
    return Number(window.localStorage.getItem(MINI_PLAYER_WIDTH_KEY)) || 320
  } catch {
    return 320
  }
}

const miniIconButtonClass =
  'pointer-events-auto flex size-8 shrink-0 items-center justify-center rounded-md text-on-media/80 transition-colors hover:bg-on-media/15 hover:text-on-media focus-visible:outline focus-visible:outline-ring data-[popup-open]:bg-on-media/15 data-[popup-open]:text-on-media'

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
      <TooltipTrigger
        render={
          <button
            type="button"
            data-mini-control
            aria-label={label}
            className={miniIconButtonClass}
            onClick={onClick}
          />
        }
      >
        {children}
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
        <Checkbox
          checked={muted}
          aria-label={t('actions.muteStream')}
          onCheckedChange={(checked) =>
            voiceListenerStore.setStreamMuted(userId, checked === true)
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
            max={VOICE_VOLUME_PERCENT_MAX}
            step={1}
            value={[muted ? 0 : streamVolumeToPercent(volume)]}
            onValueChange={(value) => {
              const next = typeof value === 'number' ? value : value[0]
              if (next == null) return
              if (muted && next > 0) {
                voiceListenerStore.setStreamMuted(userId, false)
              }
              voiceListenerStore.setStreamVolume(
                userId,
                streamVolumeFromPercent(next),
              )
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
        <TooltipTrigger render={<span />}>
          <PopoverTrigger render={<button
              type="button"
              data-mini-control
              aria-label={t('stream.settings')}
              className={miniIconButtonClass} />}>
              <Settings2Icon className="size-4.5" />
            </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('stream.settings')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        data-mini-control
        side="top"
        align="end"
        sideOffset={8}
        className={cn(
          // eslint-disable-next-line shadcn/require-static-classes -- shared voice popover surface class
          voiceStagePopoverContentClass,
          'z-510 max-h-voice-popover w-64 overflow-y-auto',
        )}
      >
        {remoteUserId ? <MiniStreamVolumeSection userId={remoteUserId} /> : null}
        {remoteUserId && showOwnQuality ? (
          <Separator className="my-1.5" />
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

/** A joined activity keeps running in the mini player while you browse. */
function MiniActivityContent({
  instance,
  application,
  currentUserId,
  channelName,
  onReturn,
}: {
  instance: ActivityInstance
  application: ActivityApplication
  currentUserId: string
  channelName: string
  onReturn: () => void
}) {
  const t = useTranslations('voice')
  const tA = useTranslations('activities')
  return (
    <div className="flex size-full flex-col">
      <div className="flex h-9 shrink-0 cursor-grab items-center gap-1 px-1 text-on-media">
        <button
          type="button"
          data-mini-control
          aria-label={t('miniPlayer.back')}
          title={channelName}
          className="flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pr-2 pl-0.5 text-sm font-semibold text-on-media/90 transition-colors hover:bg-on-media/15 hover:text-on-media focus-visible:outline focus-visible:outline-ring"
          onClick={onReturn}
        >
          <ChevronLeftIcon className="size-5 shrink-0" />
          <span className="truncate">{channelName}</span>
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-on-media/70">
          {application.name}
        </span>
        <MiniControl
          label={tA('leave')}
          onClick={() => {
            void activityStore
              .leave(instance.channel_id, instance.id)
              .catch(() => undefined)
          }}
        >
          <LogOutIcon className="size-4.5" />
        </MiniControl>
      </div>
      <div data-mini-control className="min-h-0 flex-1">
        <ActivityFrame
          application={application}
          instance={instance}
          currentUserId={currentUserId}
          layout="mini"
        />
      </div>
    </div>
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
        <VolumeXIcon className="size-4.5" />
      ) : (
        <Volume2Icon className="size-4.5" />
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
  const activityInstance = useActivityInstance(voice.stageChannelId)
  const activityApplication = useActivityApplication(
    activityInstance?.application_id,
  )
  const currentUserId = auth.user?._id ?? null
  const activity =
    activityInstance &&
    activityApplication &&
    currentUserId &&
    isActivityParticipant(activityInstance, currentUserId)
      ? { instance: activityInstance, application: activityApplication }
      : null
  const showActivity =
    activity !== null &&
    (item === null || isActivityStageItemId(voice.focusedMediaId))
  const visible = miniPlayerVisible({
    hasStream: item !== null || showActivity,
    sessionChannelId: voice.stageChannelId,
    routeChannelId: params.channelId,
    stageMounted: voice.mountedStageChannelIds.includes(
      voice.stageChannelId ?? '',
    ),
    popoutOpen: voice.popoutWindow !== null && !voice.popoutWindow.closed,
    fullscreen: voice.stageFullscreen,
  })
  if (!visible || (!item && !showActivity) || !voice.stageChannelId) {
    return null
  }
  const right = anchor.corner.endsWith('right')
  const bottom = anchor.corner.startsWith('bottom')
  const channelName =
    channel && 'name' in channel ? channel.name : t('channel')
  const streamerName = item
    ? voiceParticipantDisplayName(item.userId, users, auth.user, t)
    : ''
  const isControl = (target: EventTarget) =>
    target instanceof Element && target.closest('[data-mini-control]') !== null
  const returnToChannel = () => {
    if (anchor.consumeSuppressedClick() || suppressResizeClick.current) {
      suppressResizeClick.current = false
      return
    }
    if (!voice.stageChannelId) return
    voice.setFocusedMediaId(
      showActivity && activity
        ? activityStageItemId(activity.instance.id)
        : (item?.id ?? null),
    )
    void navigate({
      to: '/c/$channelId',
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
        className="group fixed top-0 left-0 z-500 aspect-video w-(--mini-width) touch-none select-none will-change-transform"
        style={{ '--mini-width': `${width}px` } as CSSVars}
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
            'relative size-full overflow-hidden rounded-lg bg-media-backdrop text-on-media shadow-xl ring-1 ring-shell-divider transition duration-200 ease-out motion-reduce:transition-none',
            anchor.dragging && 'scale-103 shadow-2xl',
          )}
        >
          {showActivity && activity && currentUserId ? (
            <MiniActivityContent
              instance={activity.instance}
              application={activity.application}
              currentUserId={currentUserId}
              channelName={channelName}
              onReturn={returnToChannel}
            />
          ) : item ? (
            <>
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
                  <MonitorXIcon className="size-4.5" />
                </MiniControl>
              ) : (
                <MiniControl
                  label={t('actions.stopWatching')}
                  onClick={() => voice.setStageMediaSubscribed(item.id, false)}
                >
                  <MonitorXIcon className="size-4.5" />
                </MiniControl>
              )}
            </div>
            </>
          ) : null}
        </div>

        {/* Невидимая зона изменения размера во внутреннем углу. */}
        <button
          type="button"
          data-mini-control
          aria-label={t('miniPlayer.resize')}
          className={cn(
            'absolute size-4 focus-visible:outline focus-visible:outline-ring',
            right ? 'left-0' : 'right-0',
            bottom ? 'top-0' : 'bottom-0',
            right !== bottom ? 'cursor-nesw-resize' : 'cursor-nwse-resize',
          )}
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
