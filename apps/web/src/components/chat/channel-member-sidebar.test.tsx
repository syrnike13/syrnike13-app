// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('#/components/user/user-interactive-shell', () => ({
  UserInteractiveShell: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: () => <div data-testid="avatar" />,
}))

describe('ChannelMemberSidebar', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.applyReady({
      servers: [
        {
          _id: 'server-a',
          name: 'Alpha',
          owner: 'owner',
          channels: ['channel-a'],
          default_permissions: 0,
          roles: {
            'role-a': {
              _id: 'role-a',
              name: 'Грабитель',
              colour: '#ff5c5c',
              hoist: true,
              rank: 1,
              permissions: 0,
            },
          },
        },
      ],
      channels: [
        {
          _id: 'channel-a',
          channel_type: 'TextChannel',
          server: 'server-a',
          name: 'общий',
        },
      ],
      users: [
        {
          _id: 'user-a',
          username: 'nioh13',
          display_name: 'Хан батый',
          online: true,
          relationship: 'User',
          status: { presence: 'Online', text: 'старый статус' },
        },
      ],
      members: [
        {
          _id: { server: 'server-a', user: 'user-a' },
          roles: ['role-a'],
        },
      ],
    } as never)
    syncStore.setUserMusicPresence('user-a', {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'PRAXX',
      artists: ['DK'],
      isPlaying: true,
      observedAt: 1781518000000,
    })
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('shows the current music track as the member status line', () => {
    render(
      <ChannelMemberSidebar
        channel={
          {
            _id: 'channel-a',
            channel_type: 'TextChannel',
            server: 'server-a',
            name: 'общий',
          } as never
        }
      />,
    )

    expect(screen.getByText('Хан батый')).toBeTruthy()
    expect(screen.getByText('Слушает: DK — PRAXX')).toBeTruthy()
    expect(screen.queryByText('старый статус')).toBeNull()
  })
})
