import { describe, expect, it } from 'vitest'
import type { Presence, User } from '@syrnike13/api-types'

import {
  PRESENCE_OPTIONS,
  presenceDotTitle,
  presenceLabel,
  presenceModeLabel,
} from './presence'

function userWithPresence(presence: Presence, online = true) {
  return {
    _id: 'user-1',
    username: 'tester',
    discriminator: '0001',
    online,
    status: { presence, text: null },
  } satisfies User
}

describe('presence labels', () => {
  it('renders system idle as user-facing idle', () => {
    const presence = 'SystemIdle'

    expect(presenceModeLabel(presence)).toBe('Не активен')
    expect(presenceLabel(userWithPresence(presence))).toBe('не активен')
    expect(presenceDotTitle(userWithPresence(presence))).toBe('Не активен')
  })

  it('renders system online variants as user-facing online', () => {
    const systemOnlinePresences = [
      'SystemWebOnline',
      'SystemMobileOnline',
    ] as const satisfies readonly Presence[]

    for (const presence of systemOnlinePresences) {
      expect(presenceModeLabel(presence)).toBe('В сети')
      expect(presenceLabel(userWithPresence(presence))).toBe('в сети')
      expect(presenceDotTitle(userWithPresence(presence))).toBe('В сети')
    }
  })

  it('does not expose system statuses as selectable options', () => {
    expect(PRESENCE_OPTIONS.map((option) => option.value)).toEqual([
      'Online',
      'Idle',
      'Focus',
      'Busy',
      'Invisible',
    ])
  })
})
