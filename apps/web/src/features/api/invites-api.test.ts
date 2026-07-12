import { describe, expect, it, vi } from 'vitest'

import {
  deleteInvite,
  isServerInviteJoin,
} from '#/features/api/invites-api'

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

describe('isServerInviteJoin', () => {
  it('rejects server invite join payloads without required server data', () => {
    expect(isServerInviteJoin({ type: 'Server' } as never)).toBe(false)
  })

  it('accepts server invite join payloads with member and channels', () => {
    expect(
      isServerInviteJoin({
        type: 'Server',
        server: {},
        member: {},
        channels: [],
      } as never),
    ).toBe(true)
  })
})
