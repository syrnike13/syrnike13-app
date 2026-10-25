import { ChevronDownIcon, ChevronUpIcon, Volume2BoldIcon } from '#/components/icons'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { VoiceStageTile } from '#/components/voice/voice-stage-tile'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import {
  getChannelVoiceParticipants,
  sameVoiceParticipantList,
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
  const t = useTranslations('voice')
  const auth = useAuth()
  const voice = useVoiceSession()
  const prefix = useAppRoutePrefix()
  const [expanded, setExpanded] = useState(false)
  const users = useSyncStore((s) => s.users)
  const storeParticipants = useSyncStore(
    (s) => getChannelVoiceParticipants(s, channelId, auth.user?._id),
    sameVoiceParticipantList,
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
    <div className="gradient-surface-raised shrink-0 border-b border-shell-divider bg-surface-raised text-surface-raised-foreground">
      <div className="flex items-center gap-2 px-3 py-2">
        <Volume2BoldIcon className="size-4 shrink-0 text-chart-3" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {t('dock.title', { count: participants.length })}
        </p>
        <Link
          to={`${prefix}/c/$channelId`}
          params={{ channelId }}
          search={{ m: undefined }}
          className={cn(
            buttonVariants({ size: 'sm', variant: 'ghost' }),
            'shrink-0',
          )}
        >
          {t('dock.openStage')}
        </Link>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0"
          title={expanded ? t('actions.collapse') : t('actions.expand')}
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
                  t,
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
