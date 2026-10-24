import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import type {
  AuthorizationScope,
  ErrorCode,
  ScoreMode,
} from '@syrnike13/activity-sdk/protocol'
import { Effect, Schema } from 'effect'

import { ApiError, ApiNetworkError, apiRequestEffect } from '#/lib/api/client'

// Local contracts until `packages/api-types/OpenAPI.json` is regenerated with
// the Activities routes (models: `crates/core/models/src/v0/activities.rs`).

export const ActivityApplicationSchema = Schema.Struct({
  _id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(ApiSchema.File),
  activity_url: Schema.String,
  max_participants: Schema.Number,
  first_party: Schema.optionalKey(Schema.Boolean),
})
export type ActivityApplication = typeof ActivityApplicationSchema.Type

const ActivityPlayerDataSchema = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.Unknown),
  trusted: Schema.Boolean,
  updated_at: Schema.optionalKey(Schema.String),
})
export type ActivityPlayerDataResponse = typeof ActivityPlayerDataSchema.Type

const ActivityScoreSchema = Schema.Struct({
  user_id: Schema.String,
  value: Schema.Number,
  trusted: Schema.Boolean,
  updated_at: Schema.String,
})
export type ActivityScoreResponse = typeof ActivityScoreSchema.Type

const ActivityLeaderboardSchema = Schema.Struct({
  key: Schema.String,
  entries: Schema.Array(ActivityScoreSchema),
  own: Schema.optionalKey(ActivityScoreSchema),
})
export type ActivityLeaderboardResponse = typeof ActivityLeaderboardSchema.Type

const ActivityAuthorizationCodeSchema = Schema.Struct({ code: Schema.String })

function scopePath(applicationId: string, scopeId: string) {
  return `/activities/${encodeURIComponent(applicationId)}/scopes/${encodeURIComponent(scopeId)}`
}

export const fetchActivityApplicationsEffect = Effect.fn(
  'web.activities.fetchApplications',
)(function*(token: string) {
  return yield* apiRequestEffect(
    '/activities/applications',
    Schema.Array(ActivityApplicationSchema),
    { token },
  )
})

export const fetchActivityPlayerDataEffect = Effect.fn(
  'web.activities.fetchPlayerData',
)(function*(token: string, applicationId: string, scopeId: string) {
  return yield* apiRequestEffect(
    `${scopePath(applicationId, scopeId)}/data`,
    ActivityPlayerDataSchema,
    { token },
  )
})

export const putActivityPlayerDataEffect = Effect.fn(
  'web.activities.putPlayerData',
)(function*(
  token: string,
  applicationId: string,
  scopeId: string,
  data: Readonly<Record<string, unknown>>,
) {
  return yield* apiRequestEffect(
    `${scopePath(applicationId, scopeId)}/data`,
    ActivityPlayerDataSchema,
    { method: 'PUT', token, body: { data } },
  )
})

export const putActivityScoreEffect = Effect.fn('web.activities.putScore')(
  function*(
    token: string,
    applicationId: string,
    scopeId: string,
    key: string,
    value: number,
    mode: ScoreMode,
  ) {
    return yield* apiRequestEffect(
      `${scopePath(applicationId, scopeId)}/scores/${encodeURIComponent(key)}`,
      ActivityScoreSchema,
      { method: 'PUT', token, body: { value, mode } },
    )
  },
)

export const fetchActivityLeaderboardEffect = Effect.fn(
  'web.activities.fetchLeaderboard',
)(function*(
  token: string,
  applicationId: string,
  scopeId: string,
  key: string,
  options: { limit?: number; ascending?: boolean },
) {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.ascending !== undefined) {
    query.set('ascending', String(options.ascending))
  }
  const search = query.toString()
  const suffix = search ? `?${search}` : ''
  return yield* apiRequestEffect(
    `${scopePath(applicationId, scopeId)}/leaderboards/${encodeURIComponent(key)}${suffix}`,
    ActivityLeaderboardSchema,
    { token },
  )
})

export const authorizeActivityEffect = Effect.fn('web.activities.authorize')(
  function*(
    token: string,
    applicationId: string,
    scopes: readonly AuthorizationScope[],
  ) {
    return yield* apiRequestEffect(
      `/activities/${encodeURIComponent(applicationId)}/authorize`,
      ActivityAuthorizationCodeSchema,
      { method: 'POST', token, body: { scopes } },
    )
  },
)

/** Maps an API failure to an SDK error code; never forwards response bodies. */
export function activityApiErrorCode(error: unknown): ErrorCode {
  if (error instanceof ApiNetworkError) return 'disconnected'
  if (!(error instanceof ApiError)) return 'internal'
  switch (error.status) {
    case 400:
    case 422:
      return 'invalid_request'
    case 401:
    case 403:
      return 'not_allowed'
    case 404:
      return 'unknown_application'
    case 413:
      return 'payload_too_large'
    case 429:
      return 'rate_limited'
    default:
      return 'internal'
  }
}
