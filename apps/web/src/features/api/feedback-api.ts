import type {
  DataCreateFeedbackSuggestion,
  FeedbackProductStatus,
  FeedbackSort,
  FeedbackSuggestion,
  FeedbackSuggestionPage,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export type FeedbackListParams = {
  search?: string
  category?: string
  status?: FeedbackProductStatus | 'all'
  sort?: FeedbackSort
  offset?: number
  limit?: number
}

function feedbackQuery(params: FeedbackListParams) {
  const query = new URLSearchParams()
  const search = params.search?.trim()
  const category = params.category?.trim()

  if (search) query.set('search', search)
  if (category && category !== 'all') query.set('category', category)
  if (params.status && params.status !== 'all') {
    query.set('status', params.status)
  }
  if (params.sort) query.set('sort', params.sort)
  query.set('offset', String(params.offset ?? 0))
  query.set('limit', String(params.limit ?? 20))

  return query.toString()
}

export async function fetchFeedbackSuggestions(
  token: string,
  params: FeedbackListParams,
) {
  return apiRequest<FeedbackSuggestionPage>(`/feedback?${feedbackQuery(params)}`, {
    token,
  })
}

export async function fetchMyFeedbackSuggestions(
  token: string,
  params: Pick<FeedbackListParams, 'offset' | 'limit'> = {},
) {
  return apiRequest<FeedbackSuggestionPage>(
    `/feedback/mine?${feedbackQuery(params)}`,
    { token },
  )
}

export async function fetchFeedbackSuggestion(token: string, id: string) {
  return apiRequest<FeedbackSuggestion>(`/feedback/${id}`, { token })
}

export async function createFeedbackSuggestion(
  token: string,
  data: DataCreateFeedbackSuggestion,
) {
  return apiRequest<FeedbackSuggestion>('/feedback', {
    method: 'POST',
    token,
    body: data,
  })
}

export async function addFeedbackVote(token: string, id: string) {
  return apiRequest<FeedbackSuggestion>(`/feedback/${id}/vote`, {
    method: 'PUT',
    token,
  })
}

export async function removeFeedbackVote(token: string, id: string) {
  return apiRequest<FeedbackSuggestion>(`/feedback/${id}/vote`, {
    method: 'DELETE',
    token,
  })
}
