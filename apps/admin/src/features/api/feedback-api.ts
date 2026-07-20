import type {
  DataMergeFeedbackSuggestion,
  DataRejectFeedbackSuggestion,
  DataUpdateFeedbackPublication,
  FeedbackSuggestion,
  FeedbackSuggestionPage,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

type FeedbackPageParams = {
  offset?: number
  limit?: number
}

function feedbackPageQuery({ offset = 0, limit = 50 }: FeedbackPageParams) {
  return `offset=${offset}&limit=${limit}`
}

export async function fetchPendingFeedback(
  token: string,
  params: FeedbackPageParams = {},
) {
  return apiRequest<FeedbackSuggestionPage>(
    `/feedback/admin/pending?${feedbackPageQuery(params)}`,
    { token },
  )
}

export async function fetchPublishedFeedback(
  token: string,
  params: FeedbackPageParams = {},
) {
  return apiRequest<FeedbackSuggestionPage>(
    `/feedback?sort=new&${feedbackPageQuery(params)}`,
    { token },
  )
}

export async function fetchAllPublishedFeedback(token: string) {
  const suggestions = new Map<string, FeedbackSuggestion>()
  let offset = 0

  while (true) {
    const page = await fetchPublishedFeedback(token, { offset, limit: 100 })
    for (const suggestion of page.suggestions) {
      suggestions.set(suggestion._id, suggestion)
    }

    const nextOffset = page.offset + page.suggestions.length
    if (page.suggestions.length === 0 || nextOffset >= page.total) break
    offset = nextOffset
  }

  return [...suggestions.values()]
}

export async function searchPublishedFeedback(
  token: string,
  search: string,
  params: FeedbackPageParams = { limit: 100 },
) {
  return apiRequest<FeedbackSuggestionPage>(
    `/feedback?search=${encodeURIComponent(search)}&sort=new&${feedbackPageQuery(params)}`,
    { token },
  )
}

export async function approveFeedback(token: string, id: string) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}/approve`, {
    method: 'POST',
    token,
  })
}

export async function rejectFeedback(
  token: string,
  id: string,
  data: DataRejectFeedbackSuggestion,
) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}/reject`, {
    method: 'POST',
    token,
    body: data,
  })
}

export async function mergeFeedback(
  token: string,
  id: string,
  data: DataMergeFeedbackSuggestion,
) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}/merge`, {
    method: 'POST',
    token,
    body: data,
  })
}

export async function hideFeedback(token: string, id: string) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}/hide`, {
    method: 'POST',
    token,
  })
}

export async function updateFeedback(
  token: string,
  id: string,
  data: DataUpdateFeedbackPublication,
) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}`, {
    method: 'PATCH',
    token,
    body: data,
  })
}
