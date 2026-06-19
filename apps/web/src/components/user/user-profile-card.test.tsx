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
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserProfileCard } from './user-profile-card'

const navigateMock = vi.hoisted(() => vi.fn())
const friendActionMocks = vi.hoisted(() => ({
  blockUserRelationship: vi.fn(),
  sendFriendRequestToUser: vi.fn(),
}))
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

vi.mock('#/features/friends/friend-actions', () => ({
  blockUserRelationship: (
    ...args: Parameters<typeof friendActionMocks.blockUserRelationship>
  ) => friendActionMocks.blockUserRelationship(...args),
  sendFriendRequestToUser: (
    ...args: Parameters<typeof friendActionMocks.sendFriendRequestToUser>
  ) => friendActionMocks.sendFriendRequestToUser(...args),
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

vi.mock('#/components/user/user-profile-card-header', () => ({
  UserProfileCardHeader: ({ bannerActions }: { bannerActions?: ReactNode }) => (
    <div data-testid="profile-card-header">{bannerActions}</div>
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
    friendActionMocks.blockUserRelationship.mockResolvedValue(undefined)
    friendActionMocks.sendFriendRequestToUser.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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

  it('opens a block confirmation dialog from the profile banner menu', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<UserProfileCard user={targetUser} />)

    fireEvent.click(screen.getByRole('button', { name: 'Действия профиля' }))
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(friendActionMocks.blockUserRelationship).not.toHaveBeenCalled()

    const dialog = screen
      .getAllByRole('dialog')
      .find((element) => element.textContent?.includes('@bob'))!
    expect(dialog.textContent).toContain('@bob')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Заблокировать' }),
    )

    await waitFor(() => {
      expect(friendActionMocks.blockUserRelationship).toHaveBeenCalledWith(
        'session-token',
        'target-user',
      )
    })
  })
})
