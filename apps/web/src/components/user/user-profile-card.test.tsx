// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Channel, User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserProfileCard } from './user-profile-card'
import { syncStore } from '#/features/sync/sync-store'
import { grantAllAuthorizationForTest } from '#/features/authorization/authorization-test-utils'

const navigateMock = vi.hoisted(() => vi.fn())
const openDirectMessageChannelMock = vi.hoisted(() => vi.fn())
const directMessageChannel = {
  _id: 'dm-1',
  channel_type: 'DirectMessage',
  active: true,
  recipients: ['current-user', 'target-user'],
} as Channel

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/' } }),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: openDirectMessageChannelMock,
}))

vi.mock('#/features/settings/settings-modal-context', () => ({
  useSettingsModal: () => ({ openSettings: vi.fn() }),
}))

vi.mock('#/features/api/users-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('#/features/api/users-api')>()
  return {
    ...actual,
    fetchUserProfile: vi.fn(async () => ({ content: null, background: null })),
    fetchUserMutual: vi.fn(async () => ({
      users: [],
      servers: [],
      channels: [],
    })),
    fetchUser: vi.fn(async () => ({ badges: [] })),
  }
})

const targetUser = {
  _id: 'target-user',
  username: 'bob',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

function renderProfile(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  )
}

describe('UserProfileCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openDirectMessageChannelMock.mockImplementation(
      (
        _token: string,
        _userId: string,
        navigateToChannel: (channelId: string) => Promise<void> | void,
      ) =>
        Effect.tryPromise({
          try: () => Promise.resolve(navigateToChannel('dm-1')),
          catch: (cause) => cause,
        }).pipe(Effect.as(directMessageChannel)),
    )
    syncStore.reset()
    grantAllAuthorizationForTest({ userIds: ['target-user'] })
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('opens a direct message from the profile popover', async () => {
    renderProfile(<UserProfileCard user={targetUser} />)

    fireEvent.click(screen.getByRole('button', { name: 'Открыть ЛС' }))

    await waitFor(() => {
      expect(openDirectMessageChannelMock).toHaveBeenCalledWith(
        'session-token',
        'target-user',
        expect.any(Function),
      )
    })
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/c/$channelId',
      params: { channelId: 'dm-1' },
      search: { m: undefined },
    })
  })
})
