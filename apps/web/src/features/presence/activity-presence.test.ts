import { describe, expect, it, vi } from 'vitest'
import type { Presence, User } from '@syrnike13/api-types'

import {
  createActivityPresenceController,
  HIDDEN_IDLE_AFTER_MS,
  IDLE_AFTER_MS,
} from './activity-presence'

function makeUser(presence: Presence): User {
  return {
    _id: 'user-1',
    username: 'tester',
    discriminator: '0001',
    online: true,
    status: { presence, text: null },
  } as User
}

describe('createActivityPresenceController', () => {
  it('sets Idle after inactivity when user is Online', async () => {
    let now = 0
    const applyPresence = vi.fn(async () => {})
    const controller = createActivityPresenceController({
      applyPresence,
      now: () => now,
    })

    controller.updateSnapshot({
      token: 'token-1',
      user: makeUser('Online'),
      gatewayConnected: true,
    })

    now += IDLE_AFTER_MS + 1
    controller.evaluateIdle()

    await vi.waitFor(() => {
      expect(applyPresence).toHaveBeenCalledWith(
        'Idle',
        expect.objectContaining({ _id: 'user-1' }),
        'token-1',
      )
    })
  })

  it('does not set Idle when user is Busy', async () => {
    let now = 0
    const applyPresence = vi.fn(async () => {})
    const controller = createActivityPresenceController({
      applyPresence,
      now: () => now,
    })

    controller.updateSnapshot({
      token: 'token-1',
      user: makeUser('Busy'),
      gatewayConnected: true,
    })

    now += IDLE_AFTER_MS + 1
    controller.evaluateIdle()

    expect(applyPresence).not.toHaveBeenCalled()
  })

  it('restores Online only after auto-idle', async () => {
    let now = 0
    const applyPresence = vi.fn(async () => {})
    const controller = createActivityPresenceController({
      applyPresence,
      now: () => now,
    })

    controller.updateSnapshot({
      token: 'token-1',
      user: makeUser('Online'),
      gatewayConnected: true,
    })

    now += IDLE_AFTER_MS + 1
    controller.evaluateIdle()
    await vi.waitFor(() => expect(applyPresence).toHaveBeenCalledTimes(1))

    controller.updateSnapshot({
      token: 'token-1',
      user: makeUser('Idle'),
      gatewayConnected: true,
    })

    controller.markActive()
    await vi.waitFor(() => {
      expect(applyPresence).toHaveBeenLastCalledWith(
        'Online',
        expect.any(Object),
        'token-1',
      )
    })
  })

  it('uses fresh token from updated snapshot', async () => {
    let now = 0
    const applyPresence = vi.fn(async () => {})
    const controller = createActivityPresenceController({
      applyPresence,
      now: () => now,
    })

    controller.updateSnapshot({
      token: 'token-old',
      user: makeUser('Online'),
      gatewayConnected: true,
    })

    controller.updateSnapshot({
      token: 'token-new',
      user: makeUser('Online'),
      gatewayConnected: true,
    })

    controller.onTabHidden()
    now += HIDDEN_IDLE_AFTER_MS + 1
    controller.evaluateIdle()

    await vi.waitFor(() => {
      expect(applyPresence).toHaveBeenCalledWith(
        'Idle',
        expect.any(Object),
        'token-new',
      )
    })
  })
})
