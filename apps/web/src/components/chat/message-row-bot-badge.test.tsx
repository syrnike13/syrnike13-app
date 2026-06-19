// @vitest-environment jsdom

import type { Message, User } from '@syrnike13/api-types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageRow } from '#/components/chat/message-row'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: ({ user }: { user?: User }) => (
    <span data-testid={`avatar-${user?._id ?? 'unknown'}`} />
  ),
}))

const CHANNEL_ID = 'channel-1'

function user(overrides: Partial<User> = {}): User {
  return {
    _id: 'user-1',
    username: 'user',
    discriminator: '0001',
    display_name: 'User',
    relationship: 'None',
    online: true,
    ...overrides,
  } as User
}

function message(authorId: string): Message {
  return {
    _id: 'message-1',
    channel: CHANNEL_ID,
    author: authorId,
    content: 'hello',
  } as Message
}

describe('MessageRow bot badges', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('shows a BOT badge only next to bot message authors', () => {
    const bot = user({
      _id: 'bot-user',
      username: 'deploybot',
      display_name: 'Deploy Bot',
      bot: { owner: 'owner-user' },
    })
    const human = user({
      _id: 'human-user',
      username: 'alice',
      display_name: 'Alice',
      bot: null,
    })

    const { rerender } = render(
      <MessageRow
        message={message(bot._id)}
        channelId={CHANNEL_ID}
        users={{ [bot._id]: bot }}
        emojis={{}}
        messagesById={{}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Deploy Bot' })).toBeTruthy()
    expect(screen.getByText('BOT')).toBeTruthy()

    rerender(
      <MessageRow
        message={message(human._id)}
        channelId={CHANNEL_ID}
        users={{ [human._id]: human }}
        emojis={{}}
        messagesById={{}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy()
    expect(screen.queryByText('BOT')).toBeNull()
  })
})
