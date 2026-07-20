import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeedback,
  fetchPendingFeedback,
  fetchPublishedFeedback,
  mergeFeedback,
  rejectFeedback,
  searchPublishedFeedback,
  updateFeedback,
} from '#/features/api/feedback-api'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('feedback moderation api', () => {
  beforeEach(() => mocks.apiRequest.mockReset())

  it('forwards pagination for moderation queues and catalogue search', async () => {
    await fetchPendingFeedback('token', { offset: 50, limit: 50 })
    await fetchPublishedFeedback('token', { offset: 100, limit: 50 })
    await searchPublishedFeedback('token', 'голосовые комнаты', {
      offset: 25,
      limit: 25,
    })

    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      '/feedback/admin/pending?offset=50&limit=50',
      { token: 'token' },
    )
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      '/feedback?sort=new&offset=100&limit=50',
      { token: 'token' },
    )
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      3,
      '/feedback?search=%D0%B3%D0%BE%D0%BB%D0%BE%D1%81%D0%BE%D0%B2%D1%8B%D0%B5%20%D0%BA%D0%BE%D0%BC%D0%BD%D0%B0%D1%82%D1%8B&sort=new&offset=25&limit=25',
      { token: 'token' },
    )
  })

  it('keeps moderation actions explicit and authenticated', async () => {
    await approveFeedback('token', 'idea-1')
    await rejectFeedback('token', 'idea-2', { reason: 'Дубль' })
    await mergeFeedback('token', 'idea-3', {
      target_id: 'idea-1',
      reason: 'Совпадает по смыслу',
    })

    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      '/feedback/admin/idea-1/approve',
      { method: 'POST', token: 'token' },
    )
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      '/feedback/admin/idea-2/reject',
      { method: 'POST', token: 'token', body: { reason: 'Дубль' } },
    )
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      3,
      '/feedback/admin/idea-3/merge',
      {
        method: 'POST',
        token: 'token',
        body: { target_id: 'idea-1', reason: 'Совпадает по смыслу' },
      },
    )
  })

  it('updates product status and official response in one admin patch', async () => {
    await updateFeedback('token', 'idea-1', {
      status: 'in_progress',
      response: 'Уже работаем',
    })

    expect(mocks.apiRequest).toHaveBeenCalledTimes(1)
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/feedback/admin/idea-1',
      {
        method: 'PATCH',
        token: 'token',
        body: { status: 'in_progress', response: 'Уже работаем' },
      },
    )
  })
})
