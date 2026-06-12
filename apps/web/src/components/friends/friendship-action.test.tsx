// @vitest-environment jsdom

import type { User } from '@syrnike13/api-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FriendshipAction } from '#/components/friends/friendship-action'

const mocks = vi.hoisted(() => ({
  acceptIncomingFriendRequest: vi.fn(async () => ({})),
  cancelOutgoingFriendRequest: vi.fn(async () => ({})),
  declineIncomingFriendRequest: vi.fn(async () => ({})),
  removeFriend: vi.fn(async () => ({})),
  sendFriendRequestToUser: vi.fn(async () => ({})),
  unblockBlockedUser: vi.fn(async () => ({})),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/features/friends/friend-actions', () => mocks)

function user(relationship: User['relationship'], id = 'target-user') {
  return {
    _id: id,
    username: 'alice',
    discriminator: '1234',
    relationship,
    online: true,
  } as User
}

describe('FriendshipAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('sends a friend request when there is no relationship', async () => {
    const target = user('None')
    render(<FriendshipAction user={target} />)

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в друзья' }))

    await waitFor(() => {
      expect(mocks.sendFriendRequestToUser).toHaveBeenCalledWith(
        'session-token',
        target,
      )
    })
  })

  it('accepts incoming friend requests', async () => {
    render(<FriendshipAction user={user('Incoming')} />)

    fireEvent.click(screen.getByRole('button', { name: 'Принять' }))

    await waitFor(() => {
      expect(mocks.acceptIncomingFriendRequest).toHaveBeenCalledWith(
        'session-token',
        'target-user',
      )
    })
  })

  it('declines incoming friend requests', async () => {
    render(<FriendshipAction user={user('Incoming')} />)

    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))

    await waitFor(() => {
      expect(mocks.declineIncomingFriendRequest).toHaveBeenCalledWith(
        'session-token',
        'target-user',
      )
    })
  })

  it('cancels outgoing requests', async () => {
    render(<FriendshipAction user={user('Outgoing')} />)

    fireEvent.click(screen.getByRole('button', { name: 'Отменить заявку' }))

    await waitFor(() => {
      expect(mocks.cancelOutgoingFriendRequest).toHaveBeenCalledWith(
        'session-token',
        'target-user',
      )
    })
  })

  it('removes friends', async () => {
    render(<FriendshipAction user={user('Friend')} />)

    fireEvent.click(screen.getByRole('button', { name: 'Удалить из друзей' }))

    await waitFor(() => {
      expect(mocks.removeFriend).toHaveBeenCalledWith(
        'session-token',
        'target-user',
      )
    })
  })

  it('unblocks blocked users', async () => {
    render(<FriendshipAction user={user('Blocked')} />)

    fireEvent.click(screen.getByRole('button', { name: 'Разблокировать' }))

    await waitFor(() => {
      expect(mocks.unblockBlockedUser).toHaveBeenCalledWith(
        'session-token',
        'target-user',
      )
    })
  })

  it('does not render for self, current user relationship, or users who blocked the session user', () => {
    const { container, rerender } = render(
      <FriendshipAction user={user('None', 'current-user')} />,
    )

    expect(container.firstChild).toBeNull()

    rerender(<FriendshipAction user={user('User')} />)
    expect(container.firstChild).toBeNull()

    rerender(<FriendshipAction user={user('BlockedOther')} />)
    expect(container.firstChild).toBeNull()
  })
})
