// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from '#/components/home/home-view'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openDirectMessageChannel: vi.fn(async () => ({})),
  acceptIncomingFriendRequest: vi.fn(),
  blockUserRelationship: vi.fn(),
  cancelOutgoingFriendRequest: vi.fn(),
  declineIncomingFriendRequest: vi.fn(),
  removeFriend: vi.fn(),
  sendFriendRequestByUsername: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    search,
  }: {
    children: ReactNode
    search?: Record<string, unknown>
  }) => <a href={`/app?tab=${String(search?.tab ?? '')}`}>{children}</a>,
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/app/' } }),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: mocks.openDirectMessageChannel,
}))

vi.mock('#/features/friends/friend-actions', () => ({
  acceptIncomingFriendRequest: (
    ...args: Parameters<typeof mocks.acceptIncomingFriendRequest>
  ) => mocks.acceptIncomingFriendRequest(...args),
  blockUserRelationship: (
    ...args: Parameters<typeof mocks.blockUserRelationship>
  ) => mocks.blockUserRelationship(...args),
  cancelOutgoingFriendRequest: (
    ...args: Parameters<typeof mocks.cancelOutgoingFriendRequest>
  ) => mocks.cancelOutgoingFriendRequest(...args),
  declineIncomingFriendRequest: (
    ...args: Parameters<typeof mocks.declineIncomingFriendRequest>
  ) => mocks.declineIncomingFriendRequest(...args),
  removeFriend: (...args: Parameters<typeof mocks.removeFriend>) =>
    mocks.removeFriend(...args),
  sendFriendRequestByUsername: (
    ...args: Parameters<typeof mocks.sendFriendRequestByUsername>
  ) => mocks.sendFriendRequestByUsername(...args),
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode
    open?: boolean
  }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/components/home/active-now-panel', () => ({
  ActiveNowPanel: () => null,
}))

describe('HomeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.blockUserRelationship.mockResolvedValue(undefined)
    syncStore.reset()
    syncStore.upsertUsers([
      {
        _id: 'current-user',
        username: 'me',
        discriminator: '0001',
        relationship: 'User',
        online: true,
      },
      {
        _id: 'friend-1',
        username: 'alice',
        display_name: 'Alice',
        discriminator: '0002',
        relationship: 'Friend',
        online: true,
      },
    ] as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
  })

  it('opens a direct message when clicking a friend row', async () => {
    render(<HomeView tab="all" />)

    fireEvent.click(screen.getByText('Alice'))

    await waitFor(() => {
      expect(mocks.openDirectMessageChannel).toHaveBeenCalledWith(
        'session-token',
        'friend-1',
        expect.any(Function),
      )
    })
  })

  it('shows incoming friend requests on the pending tab', () => {
    syncStore.upsertUsers([
      {
        _id: 'request-1',
        username: 'bob',
        display_name: 'Bob',
        discriminator: '0003',
        relationship: 'Incoming',
        online: true,
      },
      {
        _id: 'outgoing-1',
        username: 'carol',
        display_name: 'Carol',
        discriminator: '0004',
        relationship: 'Outgoing',
        online: true,
      },
    ] as never)

    render(<HomeView tab="online" />)

    expect(
      screen.getByRole('link', { name: /Заявки.*1 уведомлений/ }),
    ).toBeTruthy()
  })

  it('opens a block confirmation dialog from the friend row menu', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<HomeView tab="all" />)

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.blockUserRelationship).not.toHaveBeenCalled()

    const dialog = screen
      .getAllByRole('dialog')
      .find((element) => element.textContent?.includes('@alice'))!
    expect(dialog.textContent).toContain('@alice')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Заблокировать' }),
    )

    await waitFor(() => {
      expect(mocks.blockUserRelationship).toHaveBeenCalledWith(
        'session-token',
        'friend-1',
      )
    })
  })
})
