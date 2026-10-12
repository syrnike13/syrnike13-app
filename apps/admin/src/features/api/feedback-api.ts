import type {
  DataMergeFeedbackSuggestion,
  DataRejectFeedbackSuggestion,
  DataUpdateFeedbackPublication,
  FeedbackSuggestion,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

type FeedbackPageParams = {
  offset?: number
  limit?: number
}

function feedbackPageQuery({ offset = 0, limit = 50 }: FeedbackPageParams) {
  return `offset=${offset}&limit=${limit}`
}

export const fetchPendingFeedbackEffect = Effect.fn(
  'admin.feedback.fetchPending',
)(function*(token: string, params: FeedbackPageParams = {}) {
  return yield* apiRequestEffect(
    `/feedback/admin/pending?${feedbackPageQuery(params)}`,
    ApiSchema.FeedbackAdminPending200,
    { token },
  )
})

export function fetchPendingFeedback(
  token: string,
  params: FeedbackPageParams = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchPendingFeedbackEffect(token, params),
    signal ? { signal } : undefined,
  )
}

export const fetchPublishedFeedbackEffect = Effect.fn(
  'admin.feedback.fetchPublished',
)(function*(token: string, params: FeedbackPageParams = {}) {
  return yield* apiRequestEffect(
    `/feedback?sort=new&${feedbackPageQuery(params)}`,
    ApiSchema.FeedbackList200,
    { token },
  )
})

export function fetchPublishedFeedback(
  token: string,
  params: FeedbackPageParams = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchPublishedFeedbackEffect(token, params),
    signal ? { signal } : undefined,
  )
}

export const fetchAllPublishedFeedback = Effect.fn(
  'admin.feedback.fetchAllPublished',
)(function*(token: string) {
  const suggestions = new Map<string, FeedbackSuggestion>()
  let offset = 0

  while (true) {
    const page = yield* fetchPublishedFeedbackEffect(token, {
      offset,
      limit: 100,
    })
    for (const suggestion of page.suggestions) {
      suggestions.set(suggestion._id, suggestion)
    }

    const nextOffset = page.offset + page.suggestions.length
    if (page.suggestions.length === 0 || nextOffset >= page.total) break
    offset = nextOffset
  }

  return [...suggestions.values()]
})

export const searchPublishedFeedbackEffect = Effect.fn(
  'admin.feedback.searchPublished',
)(function*(
  token: string,
  search: string,
  params: FeedbackPageParams = { limit: 100 },
) {
  return yield* apiRequestEffect(
    `/feedback?search=${encodeURIComponent(search)}&sort=new&${feedbackPageQuery(params)}`,
    ApiSchema.FeedbackList200,
    { token },
  )
})

export function searchPublishedFeedback(
  token: string,
  search: string,
  params: FeedbackPageParams = { limit: 100 },
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    searchPublishedFeedbackEffect(token, search, params),
    signal ? { signal } : undefined,
  )
}

export const approveFeedbackEffect = Effect.fn('admin.feedback.approve')(
  function*(token: string, id: string) {
    return yield* apiRequestEffect(
      `/feedback/admin/${id}/approve`,
      ApiSchema.FeedbackAdminApprove200,
      {
        method: 'POST',
        token,
      },
    )
  },
)

export function approveFeedback(token: string, id: string) {
  return Effect.runPromise(approveFeedbackEffect(token, id))
}

export const rejectFeedbackEffect = Effect.fn('admin.feedback.reject')(
  function*(
    token: string,
    id: string,
    data: DataRejectFeedbackSuggestion,
  ) {
    return yield* apiRequestEffect(
      `/feedback/admin/${id}/reject`,
      ApiSchema.FeedbackAdminReject200,
      {
        method: 'POST',
        token,
        body: data,
      },
    )
  },
)

export function rejectFeedback(
  token: string,
  id: string,
  data: DataRejectFeedbackSuggestion,
) {
  return Effect.runPromise(rejectFeedbackEffect(token, id, data))
}

export const mergeFeedbackEffect = Effect.fn('admin.feedback.merge')(
  function*(
    token: string,
    id: string,
    data: DataMergeFeedbackSuggestion,
  ) {
    return yield* apiRequestEffect(
      `/feedback/admin/${id}/merge`,
      ApiSchema.FeedbackAdminMerge200,
      {
        method: 'POST',
        token,
        body: data,
      },
    )
  },
)

export function mergeFeedback(
  token: string,
  id: string,
  data: DataMergeFeedbackSuggestion,
) {
  return Effect.runPromise(mergeFeedbackEffect(token, id, data))
}

export const hideFeedbackEffect = Effect.fn('admin.feedback.hide')(
  function*(token: string, id: string) {
    return yield* apiRequestEffect(
      `/feedback/admin/${id}/hide`,
      ApiSchema.FeedbackAdminHide200,
      {
        method: 'POST',
        token,
      },
    )
  },
)

export function hideFeedback(token: string, id: string) {
  return Effect.runPromise(hideFeedbackEffect(token, id))
}

export const updateFeedbackEffect = Effect.fn('admin.feedback.update')(
  function*(
    token: string,
    id: string,
    data: DataUpdateFeedbackPublication,
  ) {
    return yield* apiRequestEffect(
      `/feedback/admin/${id}`,
      ApiSchema.FeedbackAdminUpdatePublication200,
      {
        method: 'PATCH',
        token,
        body: data,
      },
    )
  },
)

export function updateFeedback(
  token: string,
  id: string,
  data: DataUpdateFeedbackPublication,
) {
  return Effect.runPromise(updateFeedbackEffect(token, id, data))
}
