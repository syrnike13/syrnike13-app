import { describe, expect, it } from 'vitest'
import type { Presence, User } from '@syrnike13/api-types'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'

import {
  PRESENCE_OPTIONS,
  presenceDotTitle,
  presenceLabel,
  presenceModeLabel,
} from './presence'

const t = createTranslator(ru, 'ru', 'chat')

function userWithPresence(presence: Presence, online = true) {
  return {
    _id: 'user-1',
    username: 'tester',
    discriminator: '0001',
    relationship: 'None',
    online,
    status: { presence, text: null },
  } satisfies User
}

describe('presence labels', () => {
  it('renders system idle as user-facing idle', () => {
    const presence = 'SystemIdle'

    expect(presenceModeLabel(presence, t)).toBe('Не активен')
    expect(presenceLabel(userWithPresence(presence), t)).toBe('не активен')
    expect(presenceDotTitle(userWithPresence(presence), t)).toBe('Не активен')
  })

  it('renders system online variants as user-facing online', () => {
    const systemOnlinePresences = [
      'SystemWebOnline',
      'SystemMobileOnline',
    ] as const satisfies readonly Presence[]

    for (const presence of systemOnlinePresences) {
      expect(presenceModeLabel(presence, t)).toBe('В сети')
      expect(presenceLabel(userWithPresence(presence), t)).toBe('в сети')
      expect(presenceDotTitle(userWithPresence(presence), t)).toBe('В сети')
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
