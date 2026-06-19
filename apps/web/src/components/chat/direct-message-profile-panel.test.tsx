// @vitest-environment jsdom

import type { User } from '@syrnike13/api-types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DirectMessageProfilePanel } from '#/components/chat/direct-message-profile-panel'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null }),
}))

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: ({ user }: { user: User }) => (
    <span data-testid={`avatar-${user._id}`} />
  ),
}))

vi.mock('#/components/user/user-profile-status-bubble', () => ({
  UserProfileStatusBubble: () => null,
}))

function user(overrides: Partial<User> = {}): User {
  return {
    _id: 'target-user',
    username: 'target',
    discriminator: '0001',
    display_name: 'Target User',
    relationship: 'None',
    online: true,
    ...overrides,
  } as User
}

describe('DirectMessageProfilePanel', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('shows a BOT badge only next to bot profile names', () => {
    const { rerender } = render(
      <DirectMessageProfilePanel
        user={user({
          _id: 'bot-user',
          username: 'deploybot',
          display_name: 'Deploy Bot',
          bot: { owner: 'owner-user' },
        })}
        aliases={[]}
      />,
    )

    expect(screen.getByRole('heading', { name: /deploy bot/i })).toBeTruthy()
    expect(screen.getByText('BOT')).toBeTruthy()

    rerender(
      <DirectMessageProfilePanel
        user={user({
          _id: 'human-user',
          username: 'alice',
          display_name: 'Alice',
          bot: null,
        })}
        aliases={[]}
      />,
    )

    expect(screen.getByRole('heading', { name: /alice/i })).toBeTruthy()
    expect(screen.queryByText('BOT')).toBeNull()
  })
})
