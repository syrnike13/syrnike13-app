// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserContextMenuContent } from './user-context-menu-content'
import { syncStore } from '#/features/sync/sync-store'

const navigateMock = vi.hoisted(() => vi.fn())
const voiceJoinMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
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

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => ({
    join: voiceJoinMock,
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: openDirectMessageChannelMock,
}))

vi.mock('#/features/settings/settings-modal-context', () => ({
  useSettingsModal: () => ({ openSettings: vi.fn() }),
}))

vi.mock('#/components/friends/friendship-action', () => ({
  FriendshipContextMenuItems: () => null,
}))

vi.mock('#/components/user/user-context-menu-voice-controls', () => ({
  UserContextMenuVoiceControls: () => null,
}))

vi.mock('#/components/ui/context-menu', () => ({
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
}))

const targetUser = {
  _id: 'target-user',
  username: 'bob',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

describe('UserContextMenuContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    voiceJoinMock.mockResolvedValue(true)
    syncStore.reset()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('starts a direct message call from the user context menu', async () => {
    render(<UserContextMenuContent user={targetUser} />)

    fireEvent.click(screen.getByRole('button', { name: 'Позвонить' }))

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
    expect(voiceJoinMock).toHaveBeenCalledWith('dm-1')
  })
})
