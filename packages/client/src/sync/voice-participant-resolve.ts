import type { SyncState } from './types'

/** Минимальная длина id пользователя (ULID). */
const MIN_USER_ID_LENGTH = 20

export function isValidVoiceUserId(userId: string) {
  return typeof userId === 'string' && userId.length >= MIN_USER_ID_LENGTH
}

export function isResolvableVoiceParticipant(
  state: SyncState,
  userId: string,
  currentUserId?: string,
) {
  if (!isValidVoiceUserId(userId)) return false
  if (currentUserId && userId === currentUserId) return true
  return Boolean(state.users[userId])
}
