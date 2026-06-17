// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserProfileCard } from './user-profile-card'

const navigateMock = vi.hoisted(() => vi.fn())
const openDirectMessageChannelMock = vi.hoisted(() =>
  vi.fn(
    async (
      _token: string,
      _userId: string,
      navigateToChannel: (channelId: string) => Promise<void> | void,
    ) => {
      await navigateToChannel('dm-1')
      return {
        _id: 'dm-1',
        channel_type: 'DirectMessage',
        active: true,
        recipients: ['current-user', 'target-user'],
      } as Channel
    },
  ),
)

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
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
  openDirectMessageChannel: openDirectMessageChannelMock,
}))

vi.mock('#/components/user/user-profile-card-header', () => ({
  UserProfileCardHeader: () => <div data-testid="profile-card-header" />,
}))

vi.mock('#/components/user/user-activity-cards', () => ({
  UserActivityCards: ({ className }: { className?: string }) => (
    <div className={className} data-testid="activity-cards" />
  ),
}))

const targetUser = {
  _id: 'target-user',
  username: 'bob',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

describe('UserProfileCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('opens a direct message from the profile popover', async () => {
    render(<UserProfileCard user={targetUser} />)

    fireEvent.click(screen.getByRole('button', { name: 'Открыть ЛС' }))

    await waitFor(() => {
      expect(openDirectMessageChannelMock).toHaveBeenCalledWith(
        'session-token',
        'target-user',
        expect.any(Function),
      )
    })
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'dm-1' },
      search: { m: undefined },
    })
  })

  it('keeps activity cards away from the popover bottom when they are the last block', () => {
    render(
      <UserProfileCard
        user={{
          ...targetUser,
          _id: 'current-user',
        }}
      />,
    )

    const activityCards = screen.getByTestId('activity-cards')
    expect(activityCards.className).toContain('mb-4')
  })
})
