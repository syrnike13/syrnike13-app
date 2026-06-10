// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  join: vi.fn(async () => {}),
  voice: {
    channelId: 'voice-main' as string | null,
    status: 'connected' as 'idle' | 'connecting' | 'connected',
    join: vi.fn(async () => {}),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    onClick,
    params,
  }: {
    children: ReactNode
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void
    params: { channelId: string }
  }) => (
    <a href={`/app/c/${params.channelId}`} onClick={onClick}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => mocks.voice,
}))

vi.mock('#/components/channels/channel-settings-dialog', () => ({
  ChannelSettingsDialog: () => null,
}))

vi.mock('#/components/voice/voice-channel-preview', () => ({
  VoiceChannelPreview: () => null,
}))

vi.mock('#/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSeparator: () => null,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

const voiceChannel = {
  _id: 'voice-main',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'main',
  voice: { max_users: null },
} as Channel

function renderVoiceItem(activeChannelId = 'text-general') {
  render(
    <ChannelSidebarItem
      channel={voiceChannel}
      activeChannelId={activeChannelId}
      users={{}}
      currentUserId="user-1"
      unreads={{}}
    />,
  )
}

describe('ChannelSidebarItem voice navigation', () => {
  beforeEach(() => {
    mocks.navigate.mockClear()
    mocks.join.mockClear()
    mocks.voice.channelId = 'voice-main'
    mocks.voice.status = 'connected'
    mocks.voice.join = mocks.join
  })

  afterEach(() => {
    cleanup()
  })

  it('explicitly opens the connected voice channel from another channel', () => {
    renderVoiceItem('text-general')

    fireEvent.click(screen.getByRole('link', { name: 'main' }))

    expect(mocks.join).not.toHaveBeenCalled()
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'voice-main' },
      search: { m: undefined },
    })
  })

  it('opens the voice channel while starting a new voice session', () => {
    mocks.voice.channelId = null
    mocks.voice.status = 'idle'
    renderVoiceItem('text-general')

    fireEvent.click(screen.getByRole('link', { name: 'main' }))

    expect(mocks.join).toHaveBeenCalledWith('voice-main')
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'voice-main' },
      search: { m: undefined },
    })
  })
})
