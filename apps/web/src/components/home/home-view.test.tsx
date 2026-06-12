// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from '#/components/home/home-view'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openDirectMessageChannel: vi.fn(async () => ({})),
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

vi.mock('#/components/home/active-now-panel', () => ({
  ActiveNowPanel: () => null,
}))

describe('HomeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
