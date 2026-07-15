import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addFeedbackVote,
  createFeedbackSuggestion,
  fetchFeedbackSuggestions,
  fetchMyFeedbackSuggestions,
  removeFeedbackVote,
} from '#/features/api/feedback-api'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('feedback api', () => {
  beforeEach(() => mocks.apiRequest.mockReset())

  it('encodes catalog filters without sending all values', async () => {
    mocks.apiRequest.mockResolvedValue({ suggestions: [], total: 0, offset: 0, limit: 20 })

    await fetchFeedbackSuggestions('token', {
      search: '  папки серверов  ',
      category: 'idea',
      area: 'navigation',
      platform: 'windows',
      status: 'all',
      sort: 'popular',
      offset: 20,
      limit: 20,
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/feedback?search=%D0%BF%D0%B0%D0%BF%D0%BA%D0%B8+%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D0%BE%D0%B2&category=idea&area=navigation&platform=windows&sort=popular&offset=20&limit=20',
      { token: 'token' },
    )
  })

  it('loads every moderation state through the own suggestions endpoint', async () => {
    mocks.apiRequest.mockResolvedValue({ suggestions: [], total: 0, offset: 0, limit: 10 })

    await fetchMyFeedbackSuggestions('token', { offset: 0, limit: 10 })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/feedback/mine?offset=0&limit=10',
      { token: 'token' },
    )
  })

  it('creates a premoderated suggestion through the authenticated endpoint', async () => {
    const body = {
      title: 'Папки для серверов',
      description: 'Позволяют организовать большой список.',
      category: 'idea' as const,
      area: 'navigation' as const,
      platform: 'windows' as const,
    }

    await createFeedbackSuggestion('token', body)

    expect(mocks.apiRequest).toHaveBeenCalledWith('/feedback', {
      method: 'POST',
      token: 'token',
      body,
    })
  })

  it('uses idempotent put and delete vote operations', async () => {
    await addFeedbackVote('token', 'idea-1')
    await removeFeedbackVote('token', 'idea-1')

    expect(mocks.apiRequest).toHaveBeenNthCalledWith(1, '/feedback/idea-1/vote', {
      method: 'PUT',
      token: 'token',
    })
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(2, '/feedback/idea-1/vote', {
      method: 'DELETE',
      token: 'token',
    })
  })
})
