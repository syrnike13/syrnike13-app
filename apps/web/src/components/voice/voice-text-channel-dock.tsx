import { ChevronDownIcon, ChevronUpIcon, Volume2BoldIcon } from '#/components/icons'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { VoiceStageTile } from '#/components/voice/voice-stage-tile'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import {
  getChannelVoiceParticipants,
  useChannelVoiceParticipantsWithLocalOverride,
} from '#/features/sync/voice-selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { isVoiceLocalUserId } from '#/features/voice/voice-connecting-preview'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import { cn } from '#/lib/utils'

type VoiceTextChannelDockProps = {
  channelId: string
}

export function VoiceTextChannelDock({ channelId }: VoiceTextChannelDockProps) {
  const auth = useAuth()
  const voice = useVoiceSession()
  const prefix = useAppRoutePrefix()
  const [expanded, setExpanded] = useState(false)
  const users = useSyncStore((s) => s.users)
  const storeParticipants = useSyncStore((s) =>
    getChannelVoiceParticipants(s, channelId, auth.user?._id),
  )

  const inThisChannel = isVoiceSessionInChannel(voice, channelId)
  const connecting =
    voice.status === 'connecting' && inThisChannel

  const participants = useChannelVoiceParticipantsWithLocalOverride(
    channelId,
    storeParticipants,
    inThisChannel ? auth.user?._id : undefined,
    inThisChannel ? voice.micPublishing : undefined,
    inThisChannel ? voice.deafened : undefined,
  )

  if (participants.length === 0) return null

  return (
    <div className="shrink-0 border-b border-shell-divider bg-background/90">
      <div className="flex items-center gap-2 px-3 py-2">
        <Volume2BoldIcon className="size-4 shrink-0 text-chart-3" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          Голос · {participants.length}{' '}
          {participants.length === 1 ? 'участник' : 'участника'}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 shrink-0"
          asChild
        >
          <Link to={`${prefix}/c/$channelId`} params={{ channelId }} search={{ m: undefined }}>
            Открыть сцену
          </Link>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          title={expanded ? 'Свернуть' : 'Развернуть'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronUpIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </Button>
      </div>
      {expanded ? (
        <div
          className={cn(
            'grid gap-2 px-3 pb-3',
            participants.length > 2 ? 'grid-cols-2' : 'grid-cols-1',
          )}
        >
          {participants.slice(0, 4).map((participant) => {
            const isSelf = isVoiceLocalUserId(
              participant.id,
              auth.user?._id ?? null,
            )
            const user =
              users[participant.id] ?? (isSelf ? auth.user ?? undefined : undefined)
            return (
              <VoiceStageTile
                key={participant.id}
                participant={participant}
                user={user}
                displayName={voiceParticipantDisplayName(
                  participant.id,
                  users,
                  auth.user,
                )}
                dimmed={connecting && isSelf}
                speaking={voice.speakingUserIds.has(participant.id)}
                compact
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
