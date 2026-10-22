import type { User } from '@syrnike13/api-types'
import type { Translator } from '@syrnike13/ui/i18n'

/** Имя для плитки/строки голоса; для себя — из сессии, не generic «Участник». */
export function voiceParticipantDisplayName(
  userId: string,
  users: Record<string, User>,
  currentUser: User | null | undefined,
  t: Translator,
) {
  if (currentUser && userId === currentUser._id) {
    return currentUser.display_name ?? currentUser.username ?? t('stage.you')
  }
  const user = users[userId]
  return user?.display_name ?? user?.username ?? t('stage.member')
}
