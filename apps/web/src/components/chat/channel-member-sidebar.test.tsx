// @vitest-environment jsdom

import type { Channel, Member, Server, User } from '@syrnike13/api-types'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/features/authorization/authorization'

vi.mock('#/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: ({ user }: { user: User }) => (
    <span data-testid={`avatar-${user._id}`} />
  ),
}))

vi.mock('#/components/user/user-interactive-shell', () => ({
  UserInteractiveShell: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

const channel = {
  _id: 'channel-1',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'general',
} as Extract<Channel, { channel_type: 'TextChannel' }>

function server(): Server {
  return {
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-user',
    channels: [],
    default_permissions: ChannelPermission.ViewChannel,
  } as Server
}

function user(overrides: Partial<User>): User {
  return {
    _id: 'user-1',
    username: 'user',
    discriminator: '0001',
    relationship: 'None',
    online: true,
    ...overrides,
  } as User
}

function member(userId: string, overrides: Partial<Member> = {}): Member {
  return {
    _id: { server: 'server-1', user: userId },
    joined_at: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Member
}

describe('ChannelMemberSidebar', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('shows only members who can view a restricted channel', () => {
    const privateChannel = {
      ...channel,
      _id: 'private-channel',
      name: 'private',
      default_permissions: {
        a: 0,
        d: ChannelPermission.ViewChannel,
      },
      role_permissions: {
        allowed: {
          a: ChannelPermission.ViewChannel,
          d: 0,
        },
      },
    } as Extract<Channel, { channel_type: 'TextChannel' }>

    syncStore.reset()
    syncStore.applyReady({
      users: [
        user({
          _id: 'allowed-user',
          username: 'allowed',
          display_name: 'Allowed User',
          discriminator: '0004',
        }),
        user({
          _id: 'blocked-user',
          username: 'blocked',
          display_name: 'Blocked User',
          discriminator: '0005',
        }),
      ],
      members: [
        member('allowed-user', { roles: ['allowed'] }),
        member('blocked-user'),
      ],
      servers: [
        {
          ...server(),
          roles: {
            allowed: {
              _id: 'allowed',
              name: 'Allowed',
              permissions: { a: 0, d: 0 },
              mentionable: false,
              rank: 1,
            },
          },
        } as Server,
      ],
      channels: [privateChannel],
    })

    render(<ChannelMemberSidebar channel={privateChannel} />)

    expect(screen.getByRole('button', { name: /allowed user/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /blocked user/i })).toBeNull()
  })
})
