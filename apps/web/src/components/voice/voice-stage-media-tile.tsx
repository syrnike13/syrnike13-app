import { useCallback, useEffect, useMemo, useState } from 'react'
import { Maximize2Icon, MonitorXIcon, VolumeXIcon } from 'lucide-react'
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
import type { VoiceStageMediaItem } from '#/features/voice/voice-provider'
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
  const hasVideo = Boolean(item.track && item.subscribed !== false)
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
      ...(!hasVideo ? tilePaletteStyle(palette) : {}),
      ...(variant === 'focus' || variant === 'grid'
        ? { aspectRatio: panelAspectRatio }
        : {}),
    }),
    [hasVideo, palette, panelAspectRatio, variant],
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
    'absolute inset-0 box-border overflow-hidden rounded-md bg-[#111214]',
    speaking && 'border-2 border-[#23a559]',
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
              : 'bg-[#111214]',
            variant === 'grid' && 'w-full',
            variant === 'focus' && 'size-full max-h-full max-w-full',
            variant === 'fullscreen' && 'size-full max-h-full max-w-full rounded-none',
            speaking && variant !== 'strip' && 'ring-2 ring-[#23a559]',
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
                  variant === 'strip' && 'size-full text-[min(1.125rem,26cqh)]',
                  variant === 'grid' &&
                    'size-16 text-base sm:size-20',
                  variant !== 'strip' &&
                    variant !== 'grid' &&
                    'size-24 text-2xl sm:size-32',
                )}
                showPresence={false}
              />
              {item.kind === 'screen' && item.subscribed === false ? (
                variant === 'strip' ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={(event) => {
                      event.stopPropagation()
                      onSetSubscribed(item.id, true)
                    }}
                  >
                    Подключиться к стриму
                  </Button>
                )
              ) : null}
              </div>
            </>
          )}

          {participant?.screensharing &&
          item.kind === 'screen' &&
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

          {variant !== 'focus' && variant !== 'fullscreen' ? (
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
                  muted={participant.server_muted || !participant.is_publishing}
                  deafened={
                    participant.server_deafened || !participant.is_receiving
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
      <ContextMenuContent className="z-[420] min-w-64 border-white/10 bg-[#2b2d31] text-white">
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
          <VolumeXIcon />
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
