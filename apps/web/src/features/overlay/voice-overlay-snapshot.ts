import type { User } from '@syrnike13/api-types'
import type { DesktopOverlaySnapshot } from '@syrnike13/platform'

import type { UserVoiceState } from '#/features/sync/voice-types'
import { userAvatarUrl } from '#/lib/media'

type OverlayUser = Pick<User, '_id' | 'username' | 'display_name' | 'avatar'>

export function buildVoiceOverlaySnapshot(input: {
  channelId: string | null
  channelLabel: string | null
  participants: readonly UserVoiceState[]
  speakingUserIds: ReadonlySet<string>
  users: Record<string, OverlayUser | undefined>
}): DesktopOverlaySnapshot {
  if (!input.channelId || !input.channelLabel) {
    return {
      active: false,
      channelId: null,
      channelLabel: null,
      participants: [],
    }
  }

  const participants = [...input.participants]
    .sort((left, right) => left.joined_at - right.joined_at)
    .flatMap((participant) => {
      const user = input.users[participant.id]
      if (!user) return []
      return [
        {
          userId: participant.id,
          displayName: user.display_name ?? user.username,
          avatarUrl: userAvatarUrl(user.avatar, { animated: false }),
          speaking: input.speakingUserIds.has(participant.id),
          muted: participant.self_mute || participant.server_muted,
          deafened: participant.self_deaf || participant.server_deafened,
          screensharing: participant.screensharing,
        },
      ]
    })

  if (participants.length === 0) {
    return {
      active: false,
      channelId: null,
      channelLabel: null,
      participants: [],
    }
  }

  return {
    active: true,
    channelId: input.channelId,
    channelLabel: input.channelLabel,
    participants,
  }
}
