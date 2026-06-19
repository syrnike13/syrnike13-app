// @vitest-environment jsdom

import type { Channel, Member, Server, User } from '@syrnike13/api-types'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { syncStore } from '#/features/sync/sync-store'

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
    default_permissions: 0,
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

function member(userId: string): Member {
  return {
    _id: { server: 'server-1', user: userId },
    joined_at: '2024-01-01T00:00:00Z',
  } as Member
}

describe('ChannelMemberSidebar', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.applyReady({
      users: [
        user({
          _id: 'bot-user',
          username: 'deploybot',
          display_name: 'Deploy Bot',
          discriminator: '0002',
          bot: { owner: 'owner-user' },
        }),
        user({
          _id: 'human-user',
          username: 'alice',
          display_name: 'Alice',
          discriminator: '0003',
          bot: null,
        }),
      ],
      members: [member('bot-user'), member('human-user')],
      servers: [server()],
      channels: [channel],
    })
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('shows a BOT badge only next to bot users', () => {
    render(<ChannelMemberSidebar channel={channel} />)

    expect(
      within(screen.getByRole('button', { name: /deploy bot/i })).getByText(
        'BOT',
      ),
    ).toBeTruthy()
    expect(
      within(screen.getByRole('button', { name: /alice/i })).queryByText('BOT'),
    ).toBeNull()
  })
})
