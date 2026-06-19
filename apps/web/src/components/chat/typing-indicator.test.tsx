// @vitest-environment jsdom

import type { User } from '@syrnike13/api-types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TypingIndicator } from '#/components/chat/typing-indicator'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: { _id: 'current-user' },
  }),
}))

function user(_id: string, displayName: string): User {
  return {
    _id,
    username: displayName.toLowerCase(),
    discriminator: '0001',
    display_name: displayName,
    relationship: 'None',
    online: true,
  } as User
}

describe('TypingIndicator', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('lists three typing users by name before falling back to a generic label', () => {
    syncStore.upsertUsers([
      user('current-user', 'Me'),
      user('alice-user', 'Alice'),
      user('bob-user', 'Bob'),
      user('carol-user', 'Carol'),
    ])
    syncStore.setUserTyping('channel-1', 'current-user', true)
    syncStore.setUserTyping('channel-1', 'alice-user', true)
    syncStore.setUserTyping('channel-1', 'bob-user', true)
    syncStore.setUserTyping('channel-1', 'carol-user', true)

    render(<TypingIndicator channelId="channel-1" />)

    const indicator = screen.getByText((text) =>
      ['Alice', 'Bob', 'Carol'].every((name) => text.includes(name)),
    )
    expect(indicator.textContent).not.toContain('Me')
    expect(indicator.textContent).not.toContain('Несколько')
  })
})
