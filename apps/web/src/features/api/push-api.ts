import type { WebPushSubscription } from '@syrnike13/api-types'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const subscribePushEffect = Effect.fn('web.push.subscribe')(
  function*(token: string, subscription: WebPushSubscription) {
    return yield* apiRequestEffect('/push/subscribe', Schema.Void, {
      method: 'POST',
      token,
      body: subscription,
    })
  },
)

export function subscribePush(
  token: string,
  subscription: WebPushSubscription,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    subscribePushEffect(token, subscription),
    signal ? { signal } : undefined,
  )
}

export const unsubscribePushEffect = Effect.fn('web.push.unsubscribe')(
  function*(token: string, subscription: WebPushSubscription) {
    return yield* apiRequestEffect('/push/unsubscribe', Schema.Void, {
      method: 'POST',
      token,
      body: subscription,
    })
  },
)

export function unsubscribePush(
  token: string,
  subscription: WebPushSubscription,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    unsubscribePushEffect(token, subscription),
    signal ? { signal } : undefined,
  )
}
