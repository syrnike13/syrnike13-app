import type {
  DataMergeFeedbackSuggestion,
  DataRejectFeedbackSuggestion,
  DataSetFeedbackProductStatus,
  DataSetFeedbackTeamResponse,
  FeedbackSuggestion,
  FeedbackSuggestionPage,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function fetchPendingFeedback(token: string) {
  return apiRequest<FeedbackSuggestionPage>(
    '/feedback/admin/pending?offset=0&limit=100',
    { token },
  )
}

export async function fetchPublishedFeedback(token: string) {
  return apiRequest<FeedbackSuggestionPage>(
    '/feedback?sort=new&offset=0&limit=100',
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

export async function setFeedbackStatus(
  token: string,
  id: string,
  data: DataSetFeedbackProductStatus,
) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}/status`, {
    method: 'PATCH',
    token,
    body: data,
  })
}

export async function setFeedbackResponse(
  token: string,
  id: string,
  data: DataSetFeedbackTeamResponse,
) {
  return apiRequest<FeedbackSuggestion>(`/feedback/admin/${id}/response`, {
    method: 'PATCH',
    token,
    body: data,
  })
}
