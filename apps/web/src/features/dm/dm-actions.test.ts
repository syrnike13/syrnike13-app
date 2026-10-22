import type { Channel } from '@syrnike13/api-types'
import { createTranslator } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import ru from '#/messages/ru.json'
import { openDirectMessageChannel } from './dm-actions'

const t = createTranslator(ru, 'ru', 'users')

describe('dm actions', () => {
  it('opens a direct message channel, stores it, selects DM context, and navigates', async () => {
    const channel = {
      _id: 'dm-1',
      channel_type: 'DirectMessage',
      active: true,
      recipients: ['current-user', 'target-user'],
    } as Channel

    const deps = {
      openDirectMessage: vi.fn(() => Effect.succeed(channel)),
      upsertChannel: vi.fn(),
      setSelectedServerId: vi.fn(),
      toastError: vi.fn(),
    }
    const navigateToChannel = vi.fn(async () => {})

    await expect(
      Effect.runPromise(
        openDirectMessageChannel(
          'token-1',
          'target-user',
          navigateToChannel,
          t,
          deps,
        ),
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
