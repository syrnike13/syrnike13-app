import type { DesktopOverlayState } from '@syrnike13/platform'

import { HeadphoneOffIcon, MicOffIcon } from '#/components/icons'
import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { VoiceOnAirBadge } from '#/components/voice/voice-participant-icons'
import { cn } from '#/lib/utils'

export function DesktopOverlayHud({ state }: { state: DesktopOverlayState }) {
  if (!state.visible || !state.snapshot.active) return null

  return (
    <main className="h-screen overflow-hidden bg-transparent p-5 text-foreground">
      <section data-overlay-panel className="w-[296px] overflow-hidden">
        <div className="space-y-1">
          {state.snapshot.participants.map((participant) => (
            <div
              key={participant.userId}
              data-participant-row
              className={cn(
                'flex min-h-10 items-center gap-2 rounded-md px-1 py-1 transition-opacity',
                !participant.speaking && 'opacity-55',
              )}
            >
              <Avatar
                aria-label={
                  participant.speaking
                    ? `${participant.displayName} говорит`
                    : participant.displayName
                }
                className={cn(
                  'size-8',
                  participant.speaking &&
                    'ring-2 ring-chart-3 ring-offset-2 ring-offset-background',
                )}
              >
                {participant.avatarUrl ? (
                  <img
                    src={participant.avatarUrl}
                    alt={participant.displayName}
                    className="aspect-square size-full object-cover"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                ) : null}
                <AvatarFallback className="bg-primary text-xs font-bold text-primary-foreground">
                  {initials(participant.displayName)}
                </AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 items-center gap-1 rounded-full bg-background/75 px-2 py-0.5 shadow-sm">
                <span
                  data-participant-name
                  className="min-w-0 truncate text-sm font-semibold text-foreground"
                >
                  {participant.displayName}
                </span>
                <span
                  data-status-icons
                  className="flex shrink-0 items-center gap-1 text-muted-foreground"
                >
                  {participant.muted ? (
                    <span title="Микрофон отключён">
                      <MicOffIcon className="size-4" />
                    </span>
                  ) : null}
                  {participant.deafened ? (
                    <span title="Звук отключён">
                      <HeadphoneOffIcon className="size-4" />
                    </span>
                  ) : null}
                </span>
                {participant.screensharing ? <VoiceOnAirBadge /> : null}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}
