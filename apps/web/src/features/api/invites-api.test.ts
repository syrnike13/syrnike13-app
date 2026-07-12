import type { Invite } from '@syrnike13/api-types'
import { describe, expect, it, vi } from 'vitest'

import {
  deleteInvite,
  getInviteInactiveReason,
  isGroupInviteJoin,
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

describe('getInviteInactiveReason', () => {
  const invite = {
    _id: 'invite-code',
    created_at: 0,
    expires_at: null,
    max_uses: null,
    uses: 0,
    revoked_at: null,
  } as Invite

  it('identifies revoked, expired, and exhausted invites', () => {
    expect(
      getInviteInactiveReason({ ...invite, revoked_at: 0 }, 100),
    ).toBe('revoked')
    expect(
      getInviteInactiveReason({ ...invite, expires_at: 0 }, 100),
    ).toBe('expired')
    expect(
      getInviteInactiveReason({ ...invite, expires_at: 100 }, 100),
    ).toBe('expired')
    expect(
      getInviteInactiveReason({ ...invite, max_uses: 2, uses: 2 }, 100),
    ).toBe('exhausted')
  })

  it('keeps usable and unlimited invites active', () => {
    expect(getInviteInactiveReason(invite, 100)).toBeNull()
    expect(
      getInviteInactiveReason({ ...invite, max_uses: 0, uses: 10 }, 100),
    ).toBeNull()
  })
})

describe('invite join response guards', () => {
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

  it('accepts group invite join payloads with channel and users', () => {
    expect(
      isGroupInviteJoin({
        type: 'Group',
        channel: { channel_type: 'Group' },
        users: [],
      } as never),
    ).toBe(true)
    expect(isGroupInviteJoin({ type: 'Group', channel: {} } as never)).toBe(
      false,
    )
  })
})
