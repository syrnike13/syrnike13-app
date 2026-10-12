import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export type {
  SyrnikeConfig,
  SyrnikeFeatures,
} from '@syrnike13/api-types'

export const fetchSyrnikeConfigEffect = Effect.fn(
  'web.config.fetchSyrnikeConfig',
)(function*() {
  return yield* apiRequestEffect('/', ApiSchema.RootRoot200)
})

export function fetchSyrnikeConfig(signal?: AbortSignal) {
  return Effect.runPromise(
    fetchSyrnikeConfigEffect(),
    signal ? { signal } : undefined,
  )
}
