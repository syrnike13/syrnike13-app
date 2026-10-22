import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const fetchUnseenBadgesEffect = Effect.fn('web.achievements.fetchUnseen')(
  function*(token: string) {
    return yield* apiRequestEffect(
      '/users/@me/badges/unseen',
      ApiSchema.UnseenBadgesFetch200,
      { token },
    )
  },
)

export const acknowledgeBadgesEffect = Effect.fn('web.achievements.acknowledge')(
  function*(token: string, badges: string[]) {
    return yield* apiRequestEffect('/users/@me/badges/seen', Schema.Void, {
      method: 'PUT',
      token,
      body: { badges },
    })
  },
)
