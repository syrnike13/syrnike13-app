import {
  HeadphoneOffIcon,
  MicOffIcon,
  MonitorUpIcon,
  VideoIcon,
} from 'lucide-react'

import { cn } from '#/lib/utils'

type VoiceParticipantIconsProps = {
  muted?: boolean
  deafened?: boolean
  serverMuted?: boolean
  serverDeafened?: boolean
  camera?: boolean
  screenshare?: boolean
  className?: string
}

export function VoiceParticipantIcons({
  muted,
  deafened,
  serverMuted,
  serverDeafened,
  camera,
  screenshare,
  className,
}: VoiceParticipantIconsProps) {
  if (!muted && !deafened && !camera && !screenshare) return null

  return (
    <span className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {muted ? (
        <MicOffIcon
          className={cn(
            'size-3.5',
            serverMuted ? 'text-[#faa61a]' : 'text-destructive/90',
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
      {screenshare ? (
        <MonitorUpIcon
          className="size-3.5 text-muted-foreground"
          aria-hidden
        />
      ) : null}
    </span>
  )
}
