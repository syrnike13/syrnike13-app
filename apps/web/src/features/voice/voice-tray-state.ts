import type { DesktopTrayVoiceState } from '@syrnike13/platform'

import type { UserVoiceState } from '#/features/sync/voice-types'

export function deriveDesktopTrayVoiceState(input: {
  channelId: string | null
  currentUserId: string | null | undefined
  localParticipant: UserVoiceState | null | undefined
  speakingUserIds: ReadonlySet<string>
}): DesktopTrayVoiceState {
  if (!input.channelId) return 'default'

  const participant = input.localParticipant
  if (!participant) return 'voice-idle'

  if (participant.self_deaf || participant.server_deafened) {
    return 'voice-deafened'
  }

  if (participant.self_mute || participant.server_muted) {
    return 'voice-muted'
  }

  return input.currentUserId && input.speakingUserIds.has(input.currentUserId)
    ? 'voice-speaking'
    : 'voice-idle'
}
