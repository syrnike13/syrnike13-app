import { Effect } from 'effect'

import { fetchUnreadsEffect } from '#/features/api/sync-api'

import { ensureVoiceUsersLoaded } from './ensure-voice-users'
import { syncStore } from './sync-store'

export const refreshSyncAfterReconnect = Effect.fn(
  'sync.refreshAfterReconnect',
)(
  function*(token: string, currentUserId: string | undefined) {
    yield* fetchUnreadsEffect(token).pipe(
      Effect.tap((unreads) =>
        Effect.sync(() => {
          syncStore.setUnreads(unreads)
        }),
      ),
      Effect.catch(() => Effect.void),
    )

    yield* Effect.sync(() => {
      const voiceParticipants = syncStore.getState().voiceParticipants
      const userIds = Object.values(voiceParticipants).flatMap((channelMap) =>
        Object.keys(channelMap),
      )
      ensureVoiceUsersLoaded(userIds.filter(Boolean), token)
      syncStore.pruneUnknownVoiceParticipants(currentUserId)
    })
  },
)
