import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '@syrnike13/client/api/client'

export const fetchSessionsEffect = Effect.fn('web.sessions.fetchAll')(
  function*(token: string) {
    return yield* apiRequestEffect(
      '/auth/session/all',
      ApiSchema.FetchAllFetchAll200,
      { token },
    )
  },
)

export function fetchSessions(token: string, signal?: AbortSignal) {
  return Effect.runPromise(
    fetchSessionsEffect(token),
    signal ? { signal } : undefined,
  )
}

export const deleteSessionEffect = Effect.fn('web.sessions.delete')(
  function*(token: string, sessionId: string) {
    return yield* apiRequestEffect(
      `/auth/session/${sessionId}`,
      Schema.Void,
      {
        method: 'DELETE',
        token,
      },
    )
  },
)

export const revokeOtherSessionsEffect = Effect.fn(
  'web.sessions.revokeOther',
)(function*(token: string) {
  return yield* apiRequestEffect('/auth/session/all', Schema.Void, {
    method: 'DELETE',
    token,
    body: { revoke_self: false },
  })
})
