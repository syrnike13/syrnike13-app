import type { MouseEvent, PointerEvent } from 'react'

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
  const stopActionPropagation = (
    event: MouseEvent<HTMLSpanElement> | PointerEvent<HTMLSpanElement>,
  ) => {
    if (onDoubleClick) {
      event.stopPropagation()
    }
  }

  return (
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center justify-center rounded-full bg-[#ed4245] px-1.5 text-[9px] font-bold leading-none tracking-wide text-white',
        onDoubleClick && 'cursor-pointer select-none',
        className,
      )}
      aria-label="В эфире"
      onClick={stopActionPropagation}
      onDoubleClick={onDoubleClick}
      onPointerDown={stopActionPropagation}
    >
      В ЭФИРЕ
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
  if (!muted && !deafened) return null

  const serverRestricted =
    (deafened && serverDeafened) || (muted && !deafened && serverMuted)
  const Icon = deafened ? HeadphoneOffIcon : MicOffIcon
  const label = deafened ? 'Без звука' : 'Микрофон выключен'

  return (
    <span
      className={cn(
        'absolute right-0 bottom-0 z-10 flex items-center justify-center rounded-full ring-2 ring-black',
        compact ? 'size-5' : 'size-6 sm:size-7',
        serverRestricted ? 'bg-[#faa61a]' : 'bg-[#ed4245]',
        className,
      )}
      aria-label={label}
    >
      <Icon
        className={cn(
          'text-white',
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
  if (!muted && !deafened && !camera && !listenerMuted) return null

  return (
    <span className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {listenerMuted ? (
        <MicOffIcon
          className="size-3.5 text-[#ed4245]"
          aria-label="Вы заглушили этого участника"
        />
      ) : null}
      {muted && !listenerMuted ? (
        <MicOffIcon
          className={cn(
            'size-3.5',
            serverMuted ? 'text-[#faa61a]' : 'text-white',
          )}
          aria-hidden
        />
      ) : null}
      {deafened ? (
        <HeadphoneOffIcon
          className={cn(
            'size-3.5',
            serverDeafened ? 'text-[#faa61a]' : 'text-muted-foreground',
          )}
          aria-hidden
        />
      ) : null}
      {camera ? (
        <VideoIcon className="size-3.5 text-muted-foreground" aria-hidden />
      ) : null}
    </span>
  )
}
