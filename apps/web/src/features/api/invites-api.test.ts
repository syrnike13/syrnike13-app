import { describe, expect, it, vi } from 'vitest'

import { deleteInvite } from '#/features/api/invites-api'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('invites api', () => {
  it('sends an audit reason when deleting an invite', async () => {
    mocks.apiRequest.mockResolvedValue(undefined)

    await deleteInvite('session-token', 'invite-code', {
      reason: 'rotated link',
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/invites/invite-code', {
      method: 'DELETE',
      token: 'session-token',
      body: { reason: 'rotated link' },
    })
  })
})
