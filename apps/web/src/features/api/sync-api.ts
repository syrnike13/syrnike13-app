import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const fetchUnreadsEffect = Effect.fn('web.sync.fetchUnreads')(
  function*(token: string) {
    return yield* apiRequestEffect(
      '/sync/unreads',
      ApiSchema.GetUnreadsUnreads200,
      { token },
    )
  },
)

export function fetchUnreads(token: string, signal?: AbortSignal) {
  return Effect.runPromise(
    fetchUnreadsEffect(token),
    signal ? { signal } : undefined,
  )
}

export const ackChannelEffect = Effect.fn('web.sync.ackChannel')(
  function*(token: string, channelId: string, messageId: string) {
    return yield* apiRequestEffect(
      `/channels/${channelId}/ack/${messageId}`,
      Schema.Void,
      {
        method: 'PUT',
        token,
      },
    )
  },
)

export function ackChannel(
  token: string,
  channelId: string,
  messageId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    ackChannelEffect(token, channelId, messageId),
    signal ? { signal } : undefined,
  )
}
