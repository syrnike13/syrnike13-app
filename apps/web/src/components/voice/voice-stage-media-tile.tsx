import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2Icon,
  Maximize2Icon,
  MonitorIcon,
  MonitorXIcon,
} from '#/components/icons'
import type { User } from '@syrnike13/api-types'

import { Button } from '#/components/ui/button'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
import { Slider } from '#/components/ui/slider'
import { UserAvatar } from '#/components/user/user-avatar'
import {
  VoiceOnAirBadge,
  VoiceParticipantIcons,
} from '#/components/voice/voice-participant-icons'
import { VoiceStageVideo } from '#/components/voice/voice-stage-video'
import type { UserVoiceState } from '#/features/sync/voice-types'
import {
  formatUserVolumeLabel,
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
  useVoiceListenerStore,
} from '#/features/voice/voice-listener-store'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import { useVoiceTilePalette } from '#/features/voice/use-voice-tile-palette'
import { tilePaletteStyle } from '#/lib/avatar-tile-palette'
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

/** Нейтральный серый фон превью стрима (как в Discord), без палитры аватара. */
const screenStreamSurfaceClass = 'absolute inset-0 bg-muted'

const unsubscribedStreamButtonClass =
  'h-auto rounded-md border border-white/20 bg-card px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-muted'

const screenStreamOwnerLabelClass =
  'absolute z-10 flex min-w-0 max-w-[calc(100%-1rem)] items-center gap-1 rounded bg-black/60 font-medium text-white'

function screenStreamOwnerLabelPositionClass(variant: StageMediaTileVariant) {
  return variant === 'strip'
    ? 'bottom-1.5 left-1 px-1.5 py-0.5 text-[10px] leading-tight'
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
  const showWatchButton = variant !== 'strip'

  return (
    <>
      <div className={screenStreamSurfaceClass} aria-hidden />

      {showWatchButton ? (
        <div className="absolute inset-0 flex items-center justify-center p-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={unsubscribedStreamButtonClass}
            onClick={(event) => {
              event.stopPropagation()
              onSubscribe()
            }}
          >
            Смотреть
          </Button>
        </div>
      ) : null}

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
  return (
    <>
      <div className={screenStreamSurfaceClass} aria-hidden />

      <div
        className="absolute inset-0 flex items-center justify-center p-3"
        role="status"
        aria-label="Подключение к стриму"
      >
        <Loader2Icon
          className={cn(
            'animate-spin text-white/80',
            variant === 'strip' ? 'size-5' : 'size-8',
          )}
          aria-hidden
        />
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
          Повторить
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
  const isScreenPlaceholder =
    isFailedScreen || isUnsubscribedScreen || isLoadingScreen
  const hasVideo = Boolean(
    item.track && !isFailedScreen && !isUnsubscribedScreen,
  )
  const fit =
    variant === 'focus'
      ? 'cover'
      : isScreen
        ? 'contain'
        : 'cover'
  const mediaLabel = isScreen ? `Экран ${displayName}` : displayName
  const panelAspectRatio =
    isScreen && hasVideo ? aspectRatio : DEFAULT_SCREEN_ASPECT_RATIO
  const tileStyle = useMemo(
    () => ({
      ...(!hasVideo && !isScreenPlaceholder ? tilePaletteStyle(palette) : {}),
      // Размер grid-плитки задаёт обёртка (VoiceStageGrid), aspect-ratio не нужен.
      ...(variant === 'focus' ? { aspectRatio: panelAspectRatio } : {}),
    }),
    [hasVideo, isScreenPlaceholder, palette, panelAspectRatio, variant],
  )
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
      <ContextMenuTrigger asChild>
        <article
          role="button"
          tabIndex={0}
          className={cn(
            'group relative min-h-0 rounded-md outline-none ring-offset-2 ring-offset-black transition-[filter,box-shadow,opacity]',
            'overflow-hidden',
            dimmed && 'opacity-50',
            variant === 'strip'
              ? '@container aspect-video size-full shrink-0'
              : !isScreenPlaceholder && 'bg-background',
            variant === 'grid' && 'size-full',
            variant === 'focus' && 'size-full max-h-full max-w-full',
            variant === 'fullscreen' && 'size-full max-h-full max-w-full rounded-none',
            speaking && variant !== 'strip' && 'ring-2 ring-chart-3',
            variant !== 'focus' && variant !== 'fullscreen' && 'hover:brightness-110',
          )}
          style={variant === 'strip' ? undefined : tileStyle}
          onClick={() => onFocus(item.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onFocus(item.id)
            }
          }}
        >
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
              error={item.error ?? 'Не удалось подключиться к демонстрации'}
              variant={variant}
              onRetry={() => onSetSubscribed(item.id, true)}
            />
          ) : isUnsubscribedScreen ? (
            <UnsubscribedScreenStreamTile
              displayName={displayName}
              variant={variant}
              onSubscribe={() => onSetSubscribed(item.id, true)}
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
                  className={stripMediaClipClass}
                  style={tilePaletteStyle(palette)}
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
                      'aspect-square size-[min(58cqh,36cqw,4.75rem)]',
                    variant === 'grid' && 'size-16 sm:size-20',
                    variant !== 'strip' &&
                      variant !== 'grid' &&
                      'size-24 sm:size-32',
                  )}
                  fallbackClassName={cn(
                    variant === 'strip' && 'text-[min(1.125rem,26cqh)]',
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
                'absolute z-10 flex min-w-0 items-center gap-1.5 rounded bg-black/60 font-medium text-white',
                variant === 'strip'
                  ? 'bottom-1.5 left-1 max-w-[calc(100%-0.5rem)] px-1.5 py-0.5 text-xs leading-tight'
                  : 'bottom-2 left-2 max-w-[calc(100%-3.5rem)] px-2 py-1 text-xs',
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
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[420] min-w-64 border-white/10 bg-muted text-foreground">
        <ContextMenuItem onSelect={() => onFocus(item.id)}>
          <Maximize2Icon />
          Сфокусировать
        </ContextMenuItem>
        {item.kind === 'screen' ? (
          <ContextMenuItem
            onSelect={() =>
              onSetSubscribed(item.id, item.subscribed === false)
            }
          >
            <MonitorXIcon />
            {item.isLocal
              ? 'Прекратить демонстрацию'
              : item.subscribed === false
                ? 'Подключиться к стриму'
                : 'Отключиться от просмотра'}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          indicatorPosition="end"
          checked={muted}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) => {
            if (isScreen) {
              voiceListenerStore.setStreamMuted(item.userId, checked === true)
            } else {
              voiceListenerStore.setUserMuted(item.userId, checked === true)
            }
          }}
        >
          {isScreen ? 'Заглушить стрим' : 'Заглушить голос'}
        </ContextMenuCheckboxItem>
        <div
          className="px-2 py-2"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <ContextMenuLabel className="px-0 pb-2 text-xs text-white/70">
            {isScreen ? 'Громкость стрима' : 'Громкость голоса'}
          </ContextMenuLabel>
          <div className="flex items-center gap-2">
            <Slider
              className="flex-1"
              min={0}
              max={VOICE_USER_VOLUME_MAX}
              step={0.1}
              value={[volume]}
              onValueChange={([next]) => {
                if (isScreen) {
                  voiceListenerStore.setStreamVolume(item.userId, next)
                } else {
                  voiceListenerStore.setUserVolume(item.userId, next)
                }
              }}
            />
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-white/70">
              {formatUserVolumeLabel(volume)}
            </span>
          </div>
        </div>
      </ContextMenuContent>
    </ContextMenu>
  )
}
