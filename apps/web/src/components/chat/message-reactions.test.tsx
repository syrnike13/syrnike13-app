// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageReactions } from '#/components/chat/message-reactions'
import { QUICK_REACTIONS } from '#/lib/reactions'

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
        stale: [],
        active: [reactor._id],
      },
    } as Message

    render(
      <MessageReactions
        message={message}
        users={{ [reactor._id]: reactor }}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getByText('active')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('closes the reaction picker after selecting an emoji', () => {
    const onToggle = vi.fn()
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
        active: [reactor._id],
      },
    } as Message
    const picked = QUICK_REACTIONS[1]

    render(
      <MessageReactions
        message={message}
        users={{ [reactor._id]: reactor }}
        onToggle={onToggle}
      />,
    )

    fireEvent.click(screen.getAllByRole('button')[1]!)
    fireEvent.click(screen.getByRole('button', { name: picked }))

    expect(onToggle).toHaveBeenCalledWith(picked, false)
    expect(screen.queryByRole('button', { name: picked })).toBeNull()
  })
})
