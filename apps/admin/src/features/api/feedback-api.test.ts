import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeedback,
  mergeFeedback,
  rejectFeedback,
  setFeedbackResponse,
  setFeedbackStatus,
} from '#/features/api/feedback-api'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('feedback moderation api', () => {
  beforeEach(() => mocks.apiRequest.mockReset())

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

  it('updates product status and the single official response separately', async () => {
    await setFeedbackStatus('token', 'idea-1', { status: 'in_progress' })
    await setFeedbackResponse('token', 'idea-1', { response: 'Уже работаем' })

    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      '/feedback/admin/idea-1/status',
      { method: 'PATCH', token: 'token', body: { status: 'in_progress' } },
    )
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      '/feedback/admin/idea-1/response',
      { method: 'PATCH', token: 'token', body: { response: 'Уже работаем' } },
    )
  })
})
