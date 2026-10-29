import type { MouseEvent, PointerEvent } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { HeadphoneOffIcon, MicOffIcon, VideoIcon } from '#/components/icons'

import { cn } from '#/lib/utils'

type VoiceOnAirBadgeProps = {
  className?: string
  onDoubleClick?: (event: MouseEvent<HTMLSpanElement>) => void
}

export function VoiceOnAirBadge({
  className,
  onDoubleClick,
}: VoiceOnAirBadgeProps) {
  const t = useTranslations('voice')
  const stopActionPropagation = (
    event: MouseEvent<HTMLSpanElement> | PointerEvent<HTMLSpanElement>,
  ) => {
    if (onDoubleClick) {
      event.stopPropagation()
    }
  }

  return (
    // eslint-disable-next-line design/no-lookalike -- on-air badge handles the double click itself and keeps clicks off the row
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1.5 text-3xs font-bold leading-none tracking-wide text-destructive-foreground',
        onDoubleClick && 'cursor-pointer select-none',
        className,
      )}
      aria-label={t('stream.onAir')}
      onClick={stopActionPropagation}
      onDoubleClick={onDoubleClick}
      onPointerDown={stopActionPropagation}
    >
      {t('stream.onAirShort')}
    </span>
  )
}

type VoiceAvatarStatusBadgeProps = {
  muted?: boolean
  deafened?: boolean
  serverMuted?: boolean
  serverDeafened?: boolean
  compact?: boolean
  className?: string
}

export function VoiceAvatarStatusBadge({
  muted,
  deafened,
  serverMuted,
  serverDeafened,
  compact = false,
  className,
}: VoiceAvatarStatusBadgeProps) {
  const t = useTranslations('voice')
  if (!muted && !deafened) return null

  const serverRestricted =
    (deafened && serverDeafened) || (muted && !deafened && serverMuted)
  const Icon = deafened ? HeadphoneOffIcon : MicOffIcon
  const label = deafened ? t('stage.deafened') : t('stage.micOff')

  return (
    <span
      className={cn(
        'absolute right-0 bottom-0 z-10 flex items-center justify-center rounded-full ring-2 ring-media-backdrop',
        compact ? 'size-5' : 'size-6 sm:size-7',
        serverRestricted ? 'bg-warning' : 'bg-destructive',
        className,
      )}
      aria-label={label}
    >
      <Icon
        className={cn(
          'text-on-media',
          compact ? 'size-2.5' : 'size-3 sm:size-3.5',
        )}
        aria-hidden
      />
    </span>
  )
}

type VoiceParticipantIconsProps = {
  muted?: boolean
  deafened?: boolean
  serverMuted?: boolean
  serverDeafened?: boolean
  /** Локально заглушен только у текущего слушателя. */
  listenerMuted?: boolean
  camera?: boolean
  className?: string
}

export function VoiceParticipantIcons({
  muted,
  deafened,
  serverMuted,
  serverDeafened,
  listenerMuted,
  camera,
  className,
}: VoiceParticipantIconsProps) {
  const t = useTranslations('voice')
  if (!muted && !deafened && !camera && !listenerMuted) return null

  return (
    <span className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {listenerMuted ? (
        <MicOffIcon
          className="size-3.5 text-destructive"
          aria-label={t('stage.participantMuted')}
        />
      ) : null}
      {muted && !listenerMuted ? (
        <MicOffIcon
          className={cn('size-3.5', serverMuted && 'text-warning')}
          aria-hidden
        />
      ) : null}
      {deafened ? (
        <HeadphoneOffIcon
          className={cn('size-3.5', serverDeafened && 'text-warning')}
          aria-hidden
        />
      ) : null}
      {camera ? (
        <VideoIcon className="size-3.5" aria-hidden />
      ) : null}
    </span>
  )
}
