import { describe, expect, it } from 'vitest'

import { selectedServerIdForChannel } from '#/features/navigation/channel-server-context'

describe('selectedServerIdForChannel', () => {
  it('returns null for direct messages', () => {
    expect(
      selectedServerIdForChannel({
        _id: 'dm-1',
        channel_type: 'DirectMessage',
        recipients: ['a', 'b'],
      } as never),
    ).toBeNull()
  })

  it('returns server id for text channels', () => {
    expect(
      selectedServerIdForChannel({
        _id: 'ch-1',
        channel_type: 'TextChannel',
        server: 'server-1',
        name: 'general',
      } as never),
    ).toBe('server-1')
  })

  it('returns null when channel is missing', () => {
    expect(selectedServerIdForChannel(undefined)).toBeNull()
  })
})
