import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const fetchOnboardHelloEffect = Effect.fn(
  'web.onboard.fetchHello',
)(function*(token: string) {
  return yield* apiRequestEffect('/onboard/hello', ApiSchema.HelloHello200, {
    token,
  })
})

export function fetchOnboardHello(
  token: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchOnboardHelloEffect(token),
    signal ? { signal } : undefined,
  )
}

export const completeOnboardingEffect = Effect.fn(
  'web.onboard.complete',
)(function*(token: string, username: string) {
  return yield* apiRequestEffect(
    '/onboard/complete',
    ApiSchema.CompleteComplete200,
    {
      method: 'POST',
      token,
      body: { username },
    },
  )
})

export function completeOnboarding(
  token: string,
  username: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    completeOnboardingEffect(token, username),
    signal ? { signal } : undefined,
  )
}
