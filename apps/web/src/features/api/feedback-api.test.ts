import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addFeedbackVote,
  createFeedbackSuggestion,
  fetchFeedbackSuggestions,
  fetchMyFeedbackSuggestions,
  removeFeedbackVote,
} from '#/features/api/feedback-api'

const mocks = vi.hoisted(() => ({ apiRequestEffect: vi.fn() }))

vi.mock('#/lib/api/client', () => ({
  apiRequestEffect: (...args: Parameters<typeof mocks.apiRequestEffect>) =>
    mocks.apiRequestEffect(...args),
}))

describe('feedback api', () => {
  beforeEach(() => {
    mocks.apiRequestEffect.mockReset()
    mocks.apiRequestEffect.mockReturnValue(Effect.void)
  })

  it('encodes catalog filters without sending all values', async () => {
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

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/feedback?search=%D0%BF%D0%B0%D0%BF%D0%BA%D0%B8+%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D0%BE%D0%B2&category=idea&area=navigation&platform=windows&sort=popular&offset=20&limit=20',
      ApiSchema.FeedbackList200,
      { token: 'token' },
    )
  })

  it('loads every moderation state through the own suggestions endpoint', async () => {
    await fetchMyFeedbackSuggestions('token', { offset: 0, limit: 10 })

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/feedback/mine?offset=0&limit=10',
      ApiSchema.FeedbackMine200,
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

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/feedback',
      ApiSchema.FeedbackCreate200,
      {
        method: 'POST',
        token: 'token',
        body,
      },
    )
  })

  it('uses idempotent put and delete vote operations', async () => {
    await addFeedbackVote('token', 'idea-1')
    await removeFeedbackVote('token', 'idea-1')

    expect(mocks.apiRequestEffect).toHaveBeenNthCalledWith(
      1,
      '/feedback/idea-1/vote',
      ApiSchema.FeedbackAddVote200,
      {
        method: 'PUT',
        token: 'token',
      },
    )
    expect(mocks.apiRequestEffect).toHaveBeenNthCalledWith(
      2,
      '/feedback/idea-1/vote',
      ApiSchema.FeedbackRemoveVote200,
      {
        method: 'DELETE',
        token: 'token',
      },
    )
  })
})
