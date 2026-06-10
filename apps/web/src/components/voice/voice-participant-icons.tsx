import type { MouseEvent } from 'react'

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
  return (
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center justify-center rounded-full bg-[#ed4245] px-1.5 text-[9px] font-bold leading-none tracking-wide text-white',
        onDoubleClick && 'cursor-pointer select-none',
        className,
      )}
      aria-label="В эфире"
      onDoubleClick={onDoubleClick}
    >
      В ЭФИРЕ
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
