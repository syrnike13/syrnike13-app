import type { User } from '@syrnike13/api-types'

import { UserAvatar } from '#/components/user/user-avatar'
import { UserInteractiveShell } from '#/components/user/user-interactive-shell'
import {
  VoiceOnAirBadge,
  VoiceParticipantIcons,
} from '#/components/voice/voice-participant-icons'
import type { MemberRoleEntry } from '#/features/sync/selectors'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { cn } from '#/lib/utils'

type VoiceParticipantRowProps = {
  participant: UserVoiceState
  user?: User
  displayName: string
  speaking?: boolean
  /** Полупрозрачно на время подключения к LiveKit. */
  dimmed?: boolean
  /** Войс активен с другого клиента — приглушённый вид в сайдбаре. */
  voiceElsewhere?: boolean
  compact?: boolean
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
}

export function VoiceParticipantRow({
  participant,
  user,
  displayName,
  speaking = false,
  dimmed = false,
  voiceElsewhere = false,
  compact = false,
  serverId,
  serverName,
  roles,
}: VoiceParticipantRowProps) {
  const muted = participant.server_muted || !participant.is_publishing
  const deafened = participant.server_deafened || !participant.is_receiving

  const isSpeaking = speaking && !voiceElsewhere

  const rowClassName = cn(
    'flex min-w-0 items-center gap-2 rounded-md px-2 py-1',
    compact ? 'text-xs' : 'text-sm',
    dimmed && 'opacity-50',
    voiceElsewhere && 'text-muted-foreground',
    isSpeaking &&
      'bg-gradient-to-r from-[#23a559]/25 via-[#23a559]/10 to-transparent',
  )

  const content = (
    <>
      <div
        className={cn(
          'relative shrink-0 rounded-full',
          isSpeaking &&
            'ring-2 ring-[#23a559] ring-offset-1 ring-offset-background',
        )}
      >
        <UserAvatar
          user={user}
          className={cn(
            compact ? 'size-6' : 'size-8',
            voiceElsewhere && 'opacity-60',
          )}
          fallbackClassName={compact ? 'size-6 text-[10px]' : 'size-8 text-xs'}
          showPresence={false}
        />
      </div>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          voiceElsewhere ? 'font-normal' : 'font-medium',
          isSpeaking ? 'text-white' : 'text-muted-foreground',
        )}
      >
        {displayName}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {participant.screensharing ? <VoiceOnAirBadge /> : null}
        <VoiceParticipantIcons
          muted={muted}
          deafened={deafened}
          serverMuted={participant.server_muted}
          serverDeafened={participant.server_deafened}
          camera={participant.camera}
        />
      </span>
    </>
  )

  if (!user) {
    return <div className={rowClassName}>{content}</div>
  }

  return (
    <UserInteractiveShell
      user={user}
      serverId={serverId}
      serverName={serverName}
      roles={roles}
      side="right"
      align="start"
      inVoice
    >
      <button
        type="button"
        title={
          voiceElsewhere
            ? 'Вы в этом канале с другой вкладки или устройства'
            : undefined
        }
        className={cn(
          rowClassName,
          'w-full cursor-pointer text-left transition-colors focus-visible:outline-none',
          isSpeaking
            ? 'hover:brightness-105 data-[state=open]:brightness-105'
            : 'hover:bg-accent focus-visible:bg-accent data-[state=open]:bg-accent',
        )}
      >
        {content}
      </button>
    </UserInteractiveShell>
  )
}
