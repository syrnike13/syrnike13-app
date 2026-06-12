import type { Channel } from '@syrnike13/api-types'
import { describe, expect, it, vi } from 'vitest'

import { openDirectMessageChannel } from './dm-actions'

describe('dm actions', () => {
  it('opens a direct message channel, stores it, selects DM context, and navigates', async () => {
    const channel = {
      _id: 'dm-1',
      channel_type: 'DirectMessage',
      active: true,
      recipients: ['current-user', 'target-user'],
    } as Channel

    const deps = {
      openDirectMessage: vi.fn().mockResolvedValue(channel),
      upsertChannel: vi.fn(),
      setSelectedServerId: vi.fn(),
      toastError: vi.fn(),
    }
    const navigateToChannel = vi.fn(async () => {})

    await expect(
      openDirectMessageChannel(
        'token-1',
        'target-user',
        navigateToChannel,
        deps,
      ),
    ).resolves.toBe(channel)

    expect(deps.openDirectMessage).toHaveBeenCalledWith(
      'token-1',
      'target-user',
    )
    expect(deps.upsertChannel).toHaveBeenCalledWith(channel)
    expect(deps.setSelectedServerId).toHaveBeenCalledWith(null)
    expect(navigateToChannel).toHaveBeenCalledWith('dm-1')
    expect(deps.toastError).not.toHaveBeenCalled()
  })
})
