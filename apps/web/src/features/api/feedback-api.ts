import type {
  DataCreateFeedbackSuggestion,
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
  FeedbackProductStatus,
  FeedbackSort,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export type FeedbackListParams = {
  search?: string
  category?: FeedbackCategory | 'all'
  area?: FeedbackArea | 'all'
  platform?: FeedbackPlatform | 'all'
  status?: FeedbackProductStatus | 'all'
  sort?: FeedbackSort
  offset?: number
  limit?: number
}

function feedbackQuery(params: FeedbackListParams) {
  const query = new URLSearchParams()
  const search = params.search?.trim()
  const category = params.category?.trim()
  const area = params.area?.trim()
  const platform = params.platform?.trim()

  if (search) query.set('search', search)
  if (category && category !== 'all') query.set('category', category)
  if (area && area !== 'all') query.set('area', area)
  if (platform && platform !== 'all') query.set('platform', platform)
  if (params.status && params.status !== 'all') {
    query.set('status', params.status)
  }
  if (params.sort) query.set('sort', params.sort)
  query.set('offset', String(params.offset ?? 0))
  query.set('limit', String(params.limit ?? 20))

  return query.toString()
}

export const fetchFeedbackSuggestionsEffect = Effect.fn(
  'web.feedback.fetchSuggestions',
)(function*(token: string, params: FeedbackListParams) {
  return yield* apiRequestEffect(
    `/feedback?${feedbackQuery(params)}`,
    ApiSchema.FeedbackList200,
    { token },
  )
})

export function fetchFeedbackSuggestions(
  token: string,
  params: FeedbackListParams,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchFeedbackSuggestionsEffect(token, params),
    signal ? { signal } : undefined,
  )
}

export const fetchMyFeedbackSuggestionsEffect = Effect.fn(
  'web.feedback.fetchMine',
)(function*(
  token: string,
  params: Pick<FeedbackListParams, 'offset' | 'limit'> = {},
) {
  return yield* apiRequestEffect(
    `/feedback/mine?${feedbackQuery(params)}`,
    ApiSchema.FeedbackMine200,
    { token },
  )
})

export function fetchMyFeedbackSuggestions(
  token: string,
  params: Pick<FeedbackListParams, 'offset' | 'limit'> = {},
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchMyFeedbackSuggestionsEffect(token, params),
    signal ? { signal } : undefined,
  )
}

export const fetchFeedbackSuggestionEffect = Effect.fn(
  'web.feedback.fetchSuggestion',
)(function*(token: string, id: string) {
  return yield* apiRequestEffect(
    `/feedback/${id}`,
    ApiSchema.FeedbackDetail200,
    { token },
  )
})

export function fetchFeedbackSuggestion(
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchFeedbackSuggestionEffect(token, id),
    signal ? { signal } : undefined,
  )
}

export const createFeedbackSuggestionEffect = Effect.fn(
  'web.feedback.createSuggestion',
)(function*(token: string, data: DataCreateFeedbackSuggestion) {
  return yield* apiRequestEffect(
    '/feedback',
    ApiSchema.FeedbackCreate200,
    {
      method: 'POST',
      token,
      body: data,
    },
  )
})

export function createFeedbackSuggestion(
  token: string,
  data: DataCreateFeedbackSuggestion,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createFeedbackSuggestionEffect(token, data),
    signal ? { signal } : undefined,
  )
}

export const addFeedbackVoteEffect = Effect.fn('web.feedback.addVote')(
  function*(token: string, id: string) {
    return yield* apiRequestEffect(
      `/feedback/${id}/vote`,
      ApiSchema.FeedbackAddVote200,
      {
        method: 'PUT',
        token,
      },
    )
  },
)

export function addFeedbackVote(
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    addFeedbackVoteEffect(token, id),
    signal ? { signal } : undefined,
  )
}

export const removeFeedbackVoteEffect = Effect.fn('web.feedback.removeVote')(
  function*(token: string, id: string) {
    return yield* apiRequestEffect(
      `/feedback/${id}/vote`,
      ApiSchema.FeedbackRemoveVote200,
      {
        method: 'DELETE',
        token,
      },
    )
  },
)

export function removeFeedbackVote(
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    removeFeedbackVoteEffect(token, id),
    signal ? { signal } : undefined,
  )
}
