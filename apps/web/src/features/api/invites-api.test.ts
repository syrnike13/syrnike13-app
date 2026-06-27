import { describe, expect, it } from 'vitest'

import { isServerInviteJoin } from './invites-api'

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
