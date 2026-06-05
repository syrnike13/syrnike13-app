import type { User } from '@syrnike13/api-types'

/** Имя для плитки/строки голоса; для себя — из сессии, не generic «Участник». */
export function voiceParticipantDisplayName(
  userId: string,
  users: Record<string, User>,
  currentUser?: User | null,
) {
  if (currentUser && userId === currentUser._id) {
    return currentUser.display_name ?? currentUser.username ?? 'Вы'
  }
  const user = users[userId]
  return user?.display_name ?? user?.username ?? 'Участник'
}
