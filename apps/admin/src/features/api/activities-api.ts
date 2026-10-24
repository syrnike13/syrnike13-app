import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'
import type { MediaUploadTag } from '#/features/api/media-api'

// Local contract until `@syrnike13/api-types` is regenerated from
// `services/backend/crates/core/models/src/v0/activities.rs`.

/** Autumn tag for Activity Application icons (`icon_file_id`). */
export const ACTIVITY_ICON_UPLOAD_TAG: MediaUploadTag = 'icons'

export const ActivityUrlMapping = Schema.Struct({
  prefix: Schema.String,
  target: Schema.String,
})
export type ActivityUrlMapping = typeof ActivityUrlMapping.Type

export const AdminActivityApplication = Schema.Struct({
  _id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(ApiSchema.File),
  activity_url: Schema.String,
  max_participants: Schema.Number,
  first_party: Schema.optionalKey(Schema.Boolean),
  origin_url: Schema.String,
  url_mappings: Schema.Array(ActivityUrlMapping),
  enabled: Schema.Boolean,
  has_client_secret: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
})

const AdminActivityApplicationList = Schema.Array(AdminActivityApplication)

const ActivityClientSecret = Schema.Struct({
  client_secret: Schema.String,
})

export type AdminActivityApplication = typeof AdminActivityApplication.Type

export type FieldsActivityApplication = 'Description' | 'Icon'

export type DataCreateActivityApplication = {
  id: string
  name: string
  description?: string
  icon_file_id?: string
  origin_url: string
  url_mappings: ActivityUrlMapping[]
  max_participants: number
  first_party: boolean
  enabled: boolean
}

export type DataEditActivityApplication = {
  name?: string
  description?: string
  icon_file_id?: string
  origin_url?: string
  url_mappings?: ActivityUrlMapping[]
  max_participants?: number
  first_party?: boolean
  enabled?: boolean
  remove?: FieldsActivityApplication[]
}

function applicationPath(id: string) {
  return `/admin/activities/${encodeURIComponent(id)}`
}

export const fetchAdminActivitiesEffect = Effect.fn(
  'admin.activities.fetchAll',
)(function*(token: string) {
  return yield* apiRequestEffect(
    '/admin/activities',
    AdminActivityApplicationList,
    { token },
  )
})

export function fetchAdminActivities(token: string, signal?: AbortSignal) {
  return Effect.runPromise(
    fetchAdminActivitiesEffect(token),
    signal ? { signal } : undefined,
  )
}

export const createAdminActivityEffect = Effect.fn('admin.activities.create')(
  function*(token: string, data: DataCreateActivityApplication) {
    return yield* apiRequestEffect(
      '/admin/activities',
      AdminActivityApplication,
      { method: 'POST', token, body: data },
    )
  },
)

export const updateAdminActivityEffect = Effect.fn('admin.activities.update')(
  function*(token: string, id: string, data: DataEditActivityApplication) {
    return yield* apiRequestEffect(
      applicationPath(id),
      AdminActivityApplication,
      { method: 'PATCH', token, body: data },
    )
  },
)

export function updateAdminActivity(
  token: string,
  id: string,
  data: DataEditActivityApplication,
) {
  return Effect.runPromise(updateAdminActivityEffect(token, id, data))
}

export const deleteAdminActivityEffect = Effect.fn('admin.activities.delete')(
  function*(token: string, id: string) {
    return yield* apiRequestEffect(applicationPath(id), Schema.Void, {
      method: 'DELETE',
      token,
    })
  },
)

export const rotateAdminActivitySecretEffect = Effect.fn(
  'admin.activities.rotateSecret',
)(function*(token: string, id: string) {
  return yield* apiRequestEffect(
    `${applicationPath(id)}/secret`,
    ActivityClientSecret,
    { method: 'POST', token },
  )
})

export function rotateAdminActivitySecret(token: string, id: string) {
  return Effect.runPromise(rotateAdminActivitySecretEffect(token, id))
}
