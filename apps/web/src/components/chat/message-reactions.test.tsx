// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageReactions } from '#/components/chat/message-reactions'

describe('MessageReactions', () => {
  afterEach(() => {
    cleanup()
  })

  it('hides reaction chips that no users have selected', () => {
    const reactor = {
      _id: 'user-1',
      username: 'isa',
      online: true,
    } as User
    const message = {
      _id: 'message-1',
      channel: 'channel-1',
      author: 'author-1',
      reactions: {
        '👍': [],
        '😀': [reactor._id],
      },
    } as Message

    render(
      <MessageReactions
        message={message}
        users={{ [reactor._id]: reactor }}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.queryByText('👍')).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getByText('😀')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })
})
