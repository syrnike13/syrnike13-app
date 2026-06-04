import { fetchUser } from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'
import { isValidVoiceUserId } from '#/features/sync/voice-participant-resolve'

const loading = new Set<string>()

export function ensureVoiceUsersLoaded(
  userIds: string[],
  token: string | undefined,
) {
  if (!token) return

  for (const userId of userIds) {
    if (!isValidVoiceUserId(userId)) continue
    if (syncStore.getState().users[userId]) continue
    if (loading.has(userId)) continue

    loading.add(userId)
    void fetchUser(token, userId)
      .then((user) => {
        syncStore.upsertUser(user)
      })
      .catch(() => {
        // пользователь недоступен — запись отфильтруем в UI
      })
      .finally(() => {
        loading.delete(userId)
      })
  }
}
