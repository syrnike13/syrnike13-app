import type {
  DataCreateBadge,
  DataEditBadge,
  DiagnosticReportResponse,
  DiagnosticReportStatus,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'
import { config } from '#/lib/config'

export type DiagnosticReport = DiagnosticReportResponse
export type { DiagnosticReportStatus }

export type DiagnosticReportFilters = {
  before?: string
  user_id?: string
  source?: string
  release_channel?: string
  area?: string
  trigger_code?: string
  status?: DiagnosticReportStatus
  limit?: string
}

export const fetchAdminDiagnosticReportsEffect = Effect.fn(
  'admin.diagnostics.fetchAll',
)(function*(
  token: string,
  filters: DiagnosticReportFilters = {},
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) search.set(key, value)
  }
  const query = search.size > 0 ? `?${search}` : ''
  return yield* apiRequestEffect(
    `/admin/diagnostics${query}`,
    ApiSchema.AdminDiagnosticsList200,
    { token },
  )
})

export function fetchAdminDiagnosticReports(
  token: string,
  filters: DiagnosticReportFilters = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchAdminDiagnosticReportsEffect(token, filters),
    signal ? { signal } : undefined,
  )
}

export const fetchAdminDiagnosticReportEffect = Effect.fn(
  'admin.diagnostics.fetch',
)(function*(token: string, id: string) {
  return yield* apiRequestEffect(
    `/admin/diagnostics/${encodeURIComponent(id)}`,
    ApiSchema.AdminDiagnosticsFetch200,
    { token },
  )
})

export function fetchAdminDiagnosticReport(
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchAdminDiagnosticReportEffect(token, id),
    signal ? { signal } : undefined,
  )
}

export const updateAdminDiagnosticReportEffect = Effect.fn(
  'admin.diagnostics.update',
)(function*(
  token: string,
  id: string,
  data: { status: DiagnosticReportStatus; notes: string },
) {
  return yield* apiRequestEffect(
    `/admin/diagnostics/${encodeURIComponent(id)}`,
    ApiSchema.AdminDiagnosticsUpdate200,
    {
      method: 'PATCH',
      token,
      body: data,
    },
  )
})

export function updateAdminDiagnosticReport(
  token: string,
  id: string,
  data: { status: DiagnosticReportStatus; notes: string },
) {
  return Effect.runPromise(
    updateAdminDiagnosticReportEffect(token, id, data),
  )
}

export const downloadAdminDiagnosticReportEffect = Effect.fn(
  'admin.diagnostics.download',
)(function*(token: string, id: string) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(
        `${config.apiUrl}/admin/diagnostics/${encodeURIComponent(id)}/download`,
        { headers: { 'X-Session-Token': token }, signal },
      ),
    catch: () => new Error('Не удалось подключиться к API'),
  })
  if (!response.ok) {
    return yield* Effect.fail(
      new Error(`Не удалось скачать отчёт: HTTP ${response.status}`),
    )
  }
  return yield* Effect.tryPromise({
    try: () => response.blob(),
    catch: () => new Error('Не удалось прочитать архив отчёта'),
  })
})

export function downloadAdminDiagnosticReport(token: string, id: string) {
  return Effect.runPromise(downloadAdminDiagnosticReportEffect(token, id))
}

export const fetchAdminBadgesEffect = Effect.fn('admin.badges.fetchAll')(
  function*(token: string) {
    return yield* apiRequestEffect(
      '/admin/badges',
      ApiSchema.BadgesList200,
      { token },
    )
  },
)

export function fetchAdminBadges(
  token: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchAdminBadgesEffect(token),
    signal ? { signal } : undefined,
  )
}

export const createAdminBadgeEffect = Effect.fn('admin.badges.create')(
  function*(token: string, data: DataCreateBadge) {
    return yield* apiRequestEffect(
      '/admin/badges',
      ApiSchema.BadgesCreate200,
      {
        method: 'POST',
        token,
        body: data,
      },
    )
  },
)

export function createAdminBadge(
  token: string,
  data: DataCreateBadge,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createAdminBadgeEffect(token, data),
    signal ? { signal } : undefined,
  )
}

export const updateAdminBadgeEffect = Effect.fn('admin.badges.update')(
  function*(token: string, badgeId: string, data: DataEditBadge) {
    return yield* apiRequestEffect(
      `/admin/badges/${badgeId}`,
      ApiSchema.BadgesEdit200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function updateAdminBadge(
  token: string,
  badgeId: string,
  data: DataEditBadge,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    updateAdminBadgeEffect(token, badgeId, data),
    signal ? { signal } : undefined,
  )
}

export const deleteAdminBadgeEffect = Effect.fn('admin.badges.delete')(
  function*(token: string, badgeId: string) {
    return yield* apiRequestEffect(
      `/admin/badges/${badgeId}`,
      Schema.Void,
      {
        method: 'DELETE',
        token,
      },
    )
  },
)

export function deleteAdminBadge(
  token: string,
  badgeId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    deleteAdminBadgeEffect(token, badgeId),
    signal ? { signal } : undefined,
  )
}

export const fetchAdminUserEffect = Effect.fn('admin.users.fetch')(
  function*(token: string, query: string) {
    return yield* apiRequestEffect(
      `/admin/users/${encodeURIComponent(query)}`,
      ApiSchema.UsersFetch200,
      { token },
    )
  },
)

export function fetchAdminUser(
  token: string,
  query: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchAdminUserEffect(token, query),
    signal ? { signal } : undefined,
  )
}

export const fetchAdminUserBadgesEffect = Effect.fn(
  'admin.users.fetchBadges',
)(function*(token: string, userId: string) {
  return yield* apiRequestEffect(
    `/admin/users/${userId}/badges`,
    ApiSchema.UserBadgesList200,
    { token },
  )
})

export function fetchAdminUserBadges(
  token: string,
  userId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchAdminUserBadgesEffect(token, userId),
    signal ? { signal } : undefined,
  )
}

export const assignAdminUserBadgeEffect = Effect.fn(
  'admin.users.assignBadge',
)(function*(token: string, userId: string, badgeId: string) {
  return yield* apiRequestEffect(
    `/admin/users/${userId}/badges/${badgeId}`,
    ApiSchema.UserBadgesAssign200,
    {
      method: 'PUT',
      token,
    },
  )
})

export function assignAdminUserBadge(
  token: string,
  userId: string,
  badgeId: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    assignAdminUserBadgeEffect(token, userId, badgeId),
    signal ? { signal } : undefined,
  )
}

export const removeAdminUserBadgeEffect = Effect.fn(
  'admin.users.removeBadge',
)(function*(token: string, userId: string, badgeId: string) {
  return yield* apiRequestEffect(
    `/admin/users/${userId}/badges/${badgeId}`,
    ApiSchema.UserBadgesRemove200,
    {
      method: 'DELETE',
      token,
    },
  )
})

export function removeAdminUserBadge(
  token: string,
  userId: string,
  badgeId: string,
) {
  return Effect.runPromise(
    removeAdminUserBadgeEffect(token, userId, badgeId),
  )
}
