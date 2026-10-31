import { Effect } from 'effect'

import { fetchUserEffect } from '@syrnike13/client/api/users-api'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import { isValidVoiceUserId } from '@syrnike13/client/sync/voice-participant-resolve'

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
    Effect.runFork(
      fetchUserEffect(token, userId).pipe(
        Effect.tap((user) =>
          Effect.sync(() => {
            syncStore.upsertUser(user)
          }),
        ),
        Effect.catch(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            loading.delete(userId)
          }),
        ),
      ),
    )
  }
}
