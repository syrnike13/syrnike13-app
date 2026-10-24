// design-allow-file restyle-shared: media-overlay controls use on-media surfaces.
import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  Maximize2Icon,
  MonitorIcon,
  MonitorXIcon,
  PauseIcon,
} from '#/components/icons'
import type { User } from '@syrnike13/api-types'

import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { ContextMenuVolume } from '#/components/voice/context-menu-volume'
import { UserAvatar } from '#/components/user/user-avatar'
import {
  VoiceOnAirBadge,
  VoiceParticipantIcons,
} from '#/components/voice/voice-participant-icons'
import { VoiceStageVideo } from '#/components/voice/voice-stage-video'
import type { UserVoiceState } from '#/features/sync/voice-types'
import {
  formatUserVolumeLabel,
  streamVolumeFromPercent,
  streamVolumeToPercent,
  VOICE_USER_VOLUME_MAX,
  VOICE_VOLUME_PERCENT_MAX,
  voiceListenerStore,
  useVoiceListenerStore,
} from '#/features/voice/voice-listener-store'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import { useVoiceTilePalette } from '#/features/voice/use-voice-tile-palette'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

export type StageMediaTileVariant = 'grid' | 'focus' | 'strip' | 'fullscreen'

type StageMediaTileProps = {
  item: VoiceStageMediaItem
  user?: User
  participant?: UserVoiceState
  displayName: string
  /** Полупрозрачная плитка на время подключения к LiveKit. */
  dimmed?: boolean
  speaking?: boolean
  variant: StageMediaTileVariant
  onFocus: (mediaId: string) => void
  onSetSubscribed: (mediaId: string, subscribed: boolean) => void
  onStreamAspectRatioChange?: (aspectRatio: number) => void
}

const DEFAULT_SCREEN_ASPECT_RATIO = 16 / 9

/** Нейтральный серый фон превью стрима, без палитры аватара. */
const screenStreamSurfaceClass = 'absolute inset-0 bg-muted'

const unsubscribedStreamButtonClass =
  'h-auto rounded-md border border-border bg-card font-medium text-card-foreground shadow-sm transition-colors hover:bg-hover'

const screenStreamOwnerLabelClass =
  'absolute z-10 flex min-w-0 max-w-media-inset-lg items-center gap-1 rounded bg-media-backdrop/60 font-medium text-on-media'

function screenStreamOwnerLabelPositionClass(variant: StageMediaTileVariant) {
  return variant === 'strip'
    ? 'bottom-1.5 left-1 px-1.5 py-0.5 text-xs leading-tight'
    : 'bottom-2 left-2 px-2 py-1 text-xs'
}

function ScreenStreamOwnerLabel({
  displayName,
  variant,
}: {
  displayName: string
  variant: StageMediaTileVariant
}) {
  return (
    <div
      className={cn(
        screenStreamOwnerLabelClass,
        screenStreamOwnerLabelPositionClass(variant),
      )}
    >
      <MonitorIcon className="size-3 shrink-0 opacity-90" aria-hidden />
      <span className="min-w-0 truncate">{displayName}</span>
    </div>
  )
}

function UnsubscribedScreenStreamTile({
  displayName,
  variant,
  onSubscribe,
}: {
  displayName: string
  variant: StageMediaTileVariant
  onSubscribe: () => void
}) {
  const t = useTranslations('voice')

  return (
    <>
      <div className={screenStreamSurfaceClass} aria-hidden />

      <div
        className={cn(
          'absolute inset-0 flex items-center justify-center',
          variant === 'strip' ? 'p-1.5' : 'p-3',
        )}
      >
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={cn(
            unsubscribedStreamButtonClass,
            variant === 'strip' ? 'px-2 py-1 text-xs' : 'px-4 py-2 text-sm',
          )}
          onClick={(event) => {
            event.stopPropagation()
            onSubscribe()
          }}
        >
          {t('actions.watch')}
        </Button>
      </div>

      <ScreenStreamOwnerLabel displayName={displayName} variant={variant} />
    </>
  )
}

function LoadingScreenStreamTile({
  displayName,
  variant,
}: {
  displayName: string
  variant: StageMediaTileVariant
}) {
  const t = useTranslations('voice')

  return (
    <>
      <div className={screenStreamSurfaceClass} aria-hidden />

      <div
        className="absolute inset-0 flex items-center justify-center p-3"
        role="status"
        aria-label={t('stage.streamConnecting')}
      >
        <Spinner
          className={cn(
            'text-on-media/80',
            variant === 'strip' ? 'size-5' : 'size-8',
          )}
          aria-hidden
        />
      </div>

      <ScreenStreamOwnerLabel displayName={displayName} variant={variant} />
    </>
  )
}

function PausedScreenStreamTile({
  displayName,
  variant,
}: {
  displayName: string
  variant: StageMediaTileVariant
}) {
  const t = useTranslations('voice')

  return (
    <>
      <div className={screenStreamSurfaceClass} aria-hidden />

      <div
        className={cn(
          'absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-muted-foreground',
          variant === 'strip' ? 'p-1.5 text-xs' : 'p-3 text-sm',
        )}
        role="status"
      >
        <PauseIcon className={variant === 'strip' ? 'size-4' : 'size-6'} aria-hidden />
        <span>{t('stage.streamPaused')}</span>
      </div>

      <ScreenStreamOwnerLabel displayName={displayName} variant={variant} />
    </>
  )
}

function FailedScreenStreamTile({
  displayName,
  error,
  variant,
  onRetry,
}: {
  displayName: string
  error: string
  variant: StageMediaTileVariant
  onRetry: () => void
}) {
  const t = useTranslations('voice')

  return (
    <>
      <div className={screenStreamSurfaceClass} aria-hidden />
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center"
        role="alert"
      >
        <MonitorXIcon className="size-7 text-destructive" aria-hidden />
        {variant !== 'strip' ? (
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onRetry()
          }}
        >
          {t('actions.retry')}
        </Button>
      </div>
      <ScreenStreamOwnerLabel displayName={displayName} variant={variant} />
    </>
  )
}

export function StageMediaTile({
  item,
  user,
  participant,
  displayName,
  dimmed = false,
  speaking = false,
  variant,
  onFocus,
  onSetSubscribed,
  onStreamAspectRatioChange,
}: StageMediaTileProps) {
  const t = useTranslations('voice')
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_SCREEN_ASPECT_RATIO)
  const isScreen = item.kind === 'screen'
  const muted = useVoiceListenerStore((s) =>
    isScreen ? s.getStreamMuted(item.userId) : s.getUserMuted(item.userId),
  )
  const volume = useVoiceListenerStore((s) =>
    isScreen ? s.getStreamVolume(item.userId) : s.getUserVolume(item.userId),
  )
  const palette = useVoiceTilePalette(user, item.userId)
  const isFailedScreen = isScreen && Boolean(item.error)
  const isUnsubscribedScreen =
    isScreen && !isFailedScreen && !item.isLocal && item.subscribed === false
  const isLoadingScreen =
    isScreen && !isFailedScreen && !isUnsubscribedScreen && !item.track
  // The sharer minimized or hid the shared window (its track is muted).
  const isPausedScreen =
    isScreen && !isFailedScreen && !isUnsubscribedScreen && !item.isLocal && !item.live
  const isScreenPlaceholder =
    isFailedScreen || isUnsubscribedScreen || isLoadingScreen || isPausedScreen
  // A muted remote camera keeps its last decoded frame: show the avatar.
  const isMutedCamera = !isScreen && !item.isLocal && !item.live
  const hasVideo = Boolean(
    item.track && !isFailedScreen && !isUnsubscribedScreen && !isPausedScreen &&
      !isMutedCamera,
  )
  const fit =
    variant === 'focus'
      ? 'cover'
      : isScreen
        ? 'contain'
        : 'cover'
  const mediaLabel = isScreen
    ? t('stage.screenOf', { name: displayName })
    : displayName
  const panelAspectRatio =
    isScreen && hasVideo ? aspectRatio : DEFAULT_SCREEN_ASPECT_RATIO
  const updateVideoSize = useCallback(
    ({ width, height }: { width: number; height: number }) => {
      if (!isScreen || width <= 0 || height <= 0) return
      setAspectRatio(width / height)
    },
    [isScreen],
  )

  useEffect(() => {
    if (variant !== 'focus' || !onStreamAspectRatioChange) return
    onStreamAspectRatioChange(panelAspectRatio)
  }, [onStreamAspectRatioChange, panelAspectRatio, variant])

  const stripMediaClipClass = cn(
    'absolute inset-0 box-border overflow-hidden rounded-md bg-background',
    speaking && 'border-2 border-chart-3',
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<article
          role="button"
          tabIndex={0}
          className={cn(
            'group relative min-h-0 overflow-hidden rounded-md outline-none transition',
            variant !== 'grid' &&
              variant !== 'strip' &&
              'ring-offset-2 ring-offset-media-backdrop',
            dimmed && 'opacity-50',
            variant === 'strip'
              ? '@container aspect-video size-full shrink-0'
              : !isScreenPlaceholder && 'bg-background',
            variant === 'grid' && 'size-full',
            variant === 'focus' && 'size-full max-h-full max-w-full',
            variant === 'fullscreen' && 'size-full max-h-full max-w-full rounded-none',
            // Grid: border внутри бокса — не срезается overflow контейнера сетки.
            speaking && variant === 'grid' && 'border-2 border-chart-3',
            speaking &&
              variant !== 'strip' &&
              variant !== 'grid' &&
              'ring-2 ring-chart-3',
            variant !== 'focus' && variant !== 'fullscreen' && 'hover:brightness-110',
            !hasVideo && !isScreenPlaceholder && 'tile-palette',
            variant === 'focus' && 'aspect-(--tile-aspect)',
          )}
          style={
            variant === 'strip'
              ? undefined
              : ({
                  '--tile-from': palette.from,
                  '--tile-to': palette.to,
                  '--tile-aspect': panelAspectRatio,
                } as CSSVars)
          }
          onClick={() => onFocus(item.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onFocus(item.id)
            }
          }} />}>
          {hasVideo && item.track ? (
            variant === 'strip' ? (
              <div className={stripMediaClipClass}>
                <VoiceStageVideo
                  mediaId={item.id}
                  track={item.track}
                  fit={fit}
                  onVideoSizeChange={updateVideoSize}
                />
              </div>
            ) : (
              <VoiceStageVideo
                mediaId={item.id}
                track={item.track}
                fit={fit}
                onVideoSizeChange={updateVideoSize}
              />
            )
          ) : isFailedScreen ? (
            <FailedScreenStreamTile
              displayName={displayName}
              error={item.error ?? t('stage.screenShareError')}
              variant={variant}
              onRetry={() => onSetSubscribed(item.id, true)}
            />
          ) : isUnsubscribedScreen ? (
            <UnsubscribedScreenStreamTile
              displayName={displayName}
              variant={variant}
              onSubscribe={() => onSetSubscribed(item.id, true)}
            />
          ) : isPausedScreen ? (
            <PausedScreenStreamTile
              displayName={displayName}
              variant={variant}
            />
          ) : isLoadingScreen ? (
            <LoadingScreenStreamTile
              displayName={displayName}
              variant={variant}
            />
          ) : (
            <>
              {variant === 'strip' ? (
                <div
                  className={cn(stripMediaClipClass, 'tile-palette')}
                  style={
                    {
                      '--tile-from': palette.from,
                      '--tile-to': palette.to,
                    } as CSSVars
                  }
                />
              ) : null}
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center',
                  variant === 'strip' ? 'px-2' : 'flex-col gap-3',
                )}
              >
                <UserAvatar
                  user={user}
                  className={cn(
                    variant === 'strip' &&
                      'aspect-square size-media-avatar',
                    variant === 'grid' && 'size-16 sm:size-20',
                    variant !== 'strip' &&
                      variant !== 'grid' &&
                      'size-24 sm:size-32',
                  )}
                  fallbackClassName={cn(
                    variant === 'strip' && 'text-stage-tile',
                    variant === 'grid' && 'size-16 text-base sm:size-20',
                    variant !== 'strip' &&
                      variant !== 'grid' &&
                      'size-24 text-2xl sm:size-32',
                  )}
                  animated="speaking"
                  speaking={speaking}
                  showPresence={false}
                />
              </div>
            </>
          )}

          {participant?.screensharing &&
          item.kind === 'screen' &&
          !isUnsubscribedScreen &&
          variant !== 'focus' &&
          variant !== 'fullscreen' ? (
            <div
              className={cn(
                'absolute z-10',
                variant === 'strip' ? 'top-1.5 right-1.5' : 'top-2 right-2',
              )}
            >
              <VoiceOnAirBadge />
            </div>
          ) : null}

          {variant !== 'focus' &&
          variant !== 'fullscreen' &&
          !isScreenPlaceholder ? (
            <div
              className={cn(
                'absolute z-10 flex min-w-0 items-center gap-1.5 rounded-md bg-media-backdrop/60 font-medium text-on-media',
                variant === 'strip'
                  ? 'bottom-1.5 left-1 max-w-media-inset-sm px-1.5 py-0.5 text-xs leading-tight'
                  : 'bottom-2 left-2 max-w-media-inset-xl px-2 py-1 text-xs',
              )}
            >
              {participant ? (
                <VoiceParticipantIcons
                  muted={participant.server_muted || participant.self_mute}
                  deafened={
                    participant.server_deafened || participant.self_deaf
                  }
                  serverMuted={participant.server_muted}
                  serverDeafened={participant.server_deafened}
                  camera={participant.camera && item.kind === 'camera'}
                />
              ) : null}
              <span className="min-w-0 truncate">{mediaLabel}</span>
            </div>
          ) : null}
        </ContextMenuTrigger>
      <ContextMenuContent className="z-420 min-w-64">
        <ContextMenuItem onClick={() => onFocus(item.id)}>
          <Maximize2Icon />
          {t('actions.focus')}
        </ContextMenuItem>
        {item.kind === 'screen' ? (
          <ContextMenuItem
            onClick={() =>
              onSetSubscribed(item.id, item.subscribed === false)
            }
          >
            <MonitorXIcon />
            {item.isLocal
              ? t('actions.stopScreenShare')
              : item.subscribed === false
                ? t('actions.connectStream')
                : t('actions.disconnectStream')}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={muted}
          closeOnClick={false}
          onCheckedChange={(checked) => {
            if (isScreen) {
              voiceListenerStore.setStreamMuted(item.userId, checked === true)
            } else {
              voiceListenerStore.setUserMuted(item.userId, checked === true)
            }
          }}
        >
          {isScreen ? t('actions.muteStream') : t('actions.muteVoice')}
        </ContextMenuCheckboxItem>
        <ContextMenuVolume
          label={isScreen ? t('actions.streamVolume') : t('actions.voiceVolume')}
          value={isScreen ? streamVolumeToPercent(volume) : volume}
          max={isScreen ? VOICE_VOLUME_PERCENT_MAX : VOICE_USER_VOLUME_MAX}
          step={isScreen ? 1 : 0.1}
          valueLabel={formatUserVolumeLabel(volume)}
          onValueChange={(next) => {
            if (isScreen) {
              voiceListenerStore.setStreamVolume(
                item.userId,
                streamVolumeFromPercent(next),
              )
            } else {
              voiceListenerStore.setUserVolume(item.userId, next)
            }
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}
