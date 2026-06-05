import { HeadphoneOffIcon, MicOffIcon, VideoIcon } from 'lucide-react'

import { cn } from '#/lib/utils'

export function VoiceOnAirBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center justify-center rounded-full bg-[#ed4245] px-1.5 text-[9px] font-bold leading-none tracking-wide text-white',
        className,
      )}
      aria-label="В эфире"
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
  camera?: boolean
  className?: string
}

export function VoiceParticipantIcons({
  muted,
  deafened,
  serverMuted,
  serverDeafened,
  camera,
  className,
}: VoiceParticipantIconsProps) {
  if (!muted && !deafened && !camera) return null

  return (
    <span className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {muted ? (
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
