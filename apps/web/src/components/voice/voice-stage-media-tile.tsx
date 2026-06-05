import { useCallback, useMemo, useState } from 'react'
import {
  ExternalLinkIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorXIcon,
  VolumeXIcon,
} from 'lucide-react'
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
import { VoiceParticipantIcons } from '#/components/voice/voice-participant-icons'
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
  speaking?: boolean
  variant: StageMediaTileVariant
  onFocus: (mediaId: string) => void
  onFullscreen: (mediaId: string) => void
  onExitFullscreen: () => void
  onOpenPopout: (mediaId: string) => void
  onSetSubscribed: (mediaId: string, subscribed: boolean) => void
}

const DEFAULT_SCREEN_ASPECT_RATIO = 16 / 9

export function StageMediaTile({
  item,
  user,
  participant,
  displayName,
  speaking = false,
  variant,
  onFocus,
  onFullscreen,
  onExitFullscreen,
  onOpenPopout,
  onSetSubscribed,
}: StageMediaTileProps) {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_SCREEN_ASPECT_RATIO)
  const muted = useVoiceListenerStore((s) => s.getUserMuted(item.userId))
  const volume = useVoiceListenerStore((s) => s.getUserVolume(item.userId))
  const palette = useVoiceTilePalette(user, item.userId)
  const hasVideo = Boolean(item.track && item.subscribed !== false)
  const isScreen = item.kind === 'screen'
  const canOpenPopout = isScreen && Boolean(item.track)
  const fit = isScreen ? 'contain' : 'cover'
  const mediaLabel = isScreen ? `Экран ${displayName}` : displayName
  const panelAspectRatio =
    isScreen && hasVideo ? aspectRatio : DEFAULT_SCREEN_ASPECT_RATIO
  const tileStyle = useMemo(
    () => ({
      ...(!hasVideo ? tilePaletteStyle(palette) : {}),
      aspectRatio: variant === 'fullscreen' ? undefined : panelAspectRatio,
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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          role="button"
          tabIndex={0}
          className={cn(
            'group relative min-h-0 overflow-hidden rounded-md bg-[#111214] outline-none ring-offset-2 ring-offset-black transition-[filter,box-shadow]',
            variant === 'grid' && 'w-full',
            variant === 'strip' && 'h-full min-w-40 shrink-0',
            variant === 'focus' && 'h-full max-h-full max-w-full',
            variant === 'fullscreen' && 'size-full max-h-full max-w-full rounded-none',
            speaking && 'ring-2 ring-primary',
            variant !== 'focus' && variant !== 'fullscreen' && 'hover:brightness-110',
          )}
          style={tileStyle}
          onClick={() => onFocus(item.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onFocus(item.id)
            }
          }}
        >
          {hasVideo && item.track ? (
            <VoiceStageVideo
              track={item.track}
              fit={fit}
              onVideoSizeChange={updateVideoSize}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <UserAvatar
                user={user}
                className={cn(
                  variant === 'grid' ? 'size-16 sm:size-20' : 'size-24 sm:size-32',
                )}
                fallbackClassName={cn(
                  variant === 'grid'
                    ? 'size-16 text-base sm:size-20'
                    : 'size-24 text-2xl sm:size-32',
                )}
                showPresence={false}
              />
              {item.kind === 'screen' && item.subscribed === false ? (
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
              ) : null}
            </div>
          )}

          <div className="absolute top-2 left-2 max-w-[calc(100%-5rem)] rounded bg-black/60 px-2 py-1 text-xs font-medium text-white">
            <span className="block truncate">{mediaLabel}</span>
          </div>

          {participant ? (
            <div className="absolute top-2 right-2">
              <VoiceParticipantIcons
                muted={participant.server_muted || !participant.is_publishing}
                deafened={participant.server_deafened || !participant.is_receiving}
                serverMuted={participant.server_muted}
                serverDeafened={participant.server_deafened}
                camera={participant.camera}
                screenshare={participant.screensharing}
                className="rounded-md bg-black/45 px-1 py-0.5"
              />
            </div>
          ) : null}
          {item.track ? (
            <div
              className={cn(
                'absolute right-2 bottom-2 flex items-center gap-1 transition-opacity',
                variant === 'grid' || variant === 'strip'
                  ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                  : 'opacity-100',
              )}
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 rounded bg-black/60 text-white hover:bg-black/80 hover:text-white"
                title="В отдельном окне"
                style={{ display: canOpenPopout ? undefined : 'none' }}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenPopout(item.id)
                }}
              >
                <ExternalLinkIcon className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 rounded bg-black/60 text-white hover:bg-black/80 hover:text-white"
                title="На весь экран"
                onClick={(event) => {
                  event.stopPropagation()
                  if (variant === 'fullscreen') {
                    onExitFullscreen()
                  } else {
                    onFullscreen(item.id)
                  }
                }}
              >
                {variant === 'fullscreen' ? (
                  <Minimize2Icon className="size-4" />
                ) : (
                  <Maximize2Icon className="size-4" />
                )}
              </Button>
            </div>
          ) : null}
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[420] min-w-64 border-white/10 bg-[#2b2d31] text-white">
        <ContextMenuItem onSelect={() => onFocus(item.id)}>
          <Maximize2Icon />
          Сфокусировать
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            variant === 'fullscreen' ? onExitFullscreen() : onFullscreen(item.id)
          }
        >
          {variant === 'fullscreen' ? <Minimize2Icon /> : <Maximize2Icon />}
          На весь экран
        </ContextMenuItem>
        {canOpenPopout ? (
          <ContextMenuItem onSelect={() => onOpenPopout(item.id)}>
            <ExternalLinkIcon />
            Стрим в отдельном окне
          </ContextMenuItem>
        ) : null}
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
            voiceListenerStore.setUserMuted(item.userId, checked === true)
          }}
        >
          <VolumeXIcon />
          Заглушить
        </ContextMenuCheckboxItem>
        <div
          className="px-2 py-2"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <ContextMenuLabel className="px-0 pb-2 text-xs text-white/70">
            Громкость стрима
          </ContextMenuLabel>
          <div className="flex items-center gap-2">
            <Slider
              className="flex-1"
              min={0}
              max={VOICE_USER_VOLUME_MAX}
              step={0.1}
              value={[volume]}
              onValueChange={([next]) => {
                voiceListenerStore.setUserVolume(item.userId, next)
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
