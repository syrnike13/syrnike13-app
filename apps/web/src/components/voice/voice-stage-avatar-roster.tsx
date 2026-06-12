import type { User } from '@syrnike13/api-types'

import { UserAvatar } from '#/components/user/user-avatar'
import { VoiceParticipantIcons } from '#/components/voice/voice-participant-icons'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { cn } from '#/lib/utils'

type VoiceStageAvatarRosterProps = {
  participants: readonly UserVoiceState[]
  users: Record<string, User | undefined>
  currentUser?: User | null
  speakingUserIds: ReadonlySet<string>
  displayName: (userId: string) => string
  dimmedUserId?: string
  compact?: boolean
  speakingEnabled?: boolean
}

function rosterAvatarSize(count: number, compact: boolean) {
  if (compact) {
    return count <= 4
      ? 'size-14 sm:size-16'
      : 'size-12 sm:size-14'
  }
  if (count <= 1) return 'size-28 sm:size-36 md:size-40'
  if (count <= 2) return 'size-24 sm:size-32 md:size-36'
  if (count <= 4) return 'size-20 sm:size-24 md:size-28'
  return 'size-16 sm:size-20'
}

export function VoiceStageAvatarRoster({
  participants,
  users,
  currentUser,
  speakingUserIds,
  displayName,
  dimmedUserId,
  compact = false,
  speakingEnabled = true,
}: VoiceStageAvatarRosterProps) {
  if (participants.length === 0) return null

  const avatarSize = rosterAvatarSize(participants.length, compact)

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center',
        compact ? 'px-2 py-1' : 'px-3 py-2',
      )}
    >
      <ul
        className={cn(
          'flex flex-wrap items-start justify-center',
          compact ? 'gap-3' : 'gap-6 sm:gap-8',
        )}
      >
        {participants.map((participant) => {
          const user =
            users[participant.id] ??
            (participant.id === currentUser?._id ? currentUser ?? undefined : undefined)
          const speaking =
            speakingEnabled && speakingUserIds.has(participant.id)
          const muted = participant.server_muted || participant.self_mute
          const deafened = participant.server_deafened || participant.self_deaf
          const name = displayName(participant.id)

          return (
            <li
              key={participant.id}
              className={cn(
                'flex max-w-[9rem] flex-col items-center gap-2 text-center',
                dimmedUserId === participant.id && 'opacity-50',
              )}
            >
              <div
                className={cn(
                  'rounded-full transition-[box-shadow]',
                  speaking && 'ring-2 ring-[#23a559] ring-offset-2 ring-offset-black',
                )}
              >
                <UserAvatar
                  user={user}
                  className={avatarSize}
                  fallbackClassName={cn(
                    avatarSize,
                    compact ? 'text-sm' : 'text-lg sm:text-xl',
                  )}
                  animated="speaking"
                  speaking={speaking}
                  showPresence={false}
                />
              </div>
              <div className="flex min-w-0 max-w-full items-center justify-center gap-1.5">
                <VoiceParticipantIcons
                  muted={muted}
                  deafened={deafened}
                  serverMuted={participant.server_muted}
                  serverDeafened={participant.server_deafened}
                  camera={participant.camera}
                  className="shrink-0 text-white/80"
                />
                <span className="truncate text-sm font-medium text-white/90">
                  {name}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
