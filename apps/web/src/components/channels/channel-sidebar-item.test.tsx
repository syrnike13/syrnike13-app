// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  join: vi.fn(async () => {}),
  openVoiceChannelDrawer: vi.fn(),
  pathname: '/app/',
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
  useMatch: () => null,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
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

vi.mock('#/features/navigation/mobile-voice-channel-drawer-context', () => ({
  useMobileVoiceChannelDrawer: () => ({
    openVoiceChannelDrawer: mocks.openVoiceChannelDrawer,
    closeVoiceChannelDrawer: vi.fn(),
    channelId: null,
  }),
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

const directMessageChannel = {
  _id: 'dm-call',
  channel_type: 'DirectMessage',
  active: true,
  recipients: ['user-1', 'caller-user'],
} as Channel

const groupChannel = {
  _id: 'group-call',
  channel_type: 'Group',
  active: true,
  name: 'Команда',
  owner: 'user-1',
  recipients: ['user-1', 'caller-user', 'friend-user'],
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
    syncStore.reset()
    mocks.navigate.mockClear()
    mocks.join.mockClear()
    mocks.openVoiceChannelDrawer.mockClear()
    mocks.pathname = '/app/'
    mocks.voice.channelId = 'voice-main'
    mocks.voice.status = 'connected'
    mocks.voice.join = mocks.join
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
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

  it('reopens the current voice screen without rejoining', () => {
    renderVoiceItem('voice-main')

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

  it('opens mobile voice drawer instead of navigating on mobile route', () => {
    mocks.pathname = '/m/'
    mocks.voice.channelId = null
    mocks.voice.status = 'idle'
    renderVoiceItem('text-general')

    fireEvent.click(screen.getByRole('link', { name: 'main' }))

    expect(mocks.openVoiceChannelDrawer).toHaveBeenCalledWith('voice-main')
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.join).not.toHaveBeenCalled()
  })

  it('keeps modifier-click navigation native', () => {
    renderVoiceItem('text-general')
    const link = screen.getByRole('link', { name: 'main' })
    link.addEventListener('click', (event) => event.preventDefault())

    fireEvent.click(link, {
      ctrlKey: true,
    })

    expect(mocks.join).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('marks incoming direct calls in the channel row', () => {
    const call = {
      channelId: 'dm-call',
      initiatorId: 'caller-user',
      phase: 'ringing' as const,
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: ['user-1'],
      declinedRecipients: [],
    }
    syncStore.setVoiceCall(call)

    render(
      <ChannelSidebarItem
        channel={directMessageChannel}
        activeChannelId="text-general"
        users={{
          'caller-user': {
            _id: 'caller-user',
            username: 'test_isa',
            discriminator: '0002',
            relationship: 'Friend',
            online: true,
          },
        }}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.getByTitle('Входящий звонок')).toBeTruthy()
  })

  it('does not mark dismissed incoming direct calls in the channel row', () => {
    const call = {
      channelId: 'dm-call',
      initiatorId: 'caller-user',
      phase: 'ringing' as const,
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: ['user-1'],
      declinedRecipients: [],
    }
    syncStore.setVoiceCall(call)
    syncStore.dismissVoiceCall(call)

    render(
      <ChannelSidebarItem
        channel={directMessageChannel}
        activeChannelId="text-general"
        users={{
          'caller-user': {
            _id: 'caller-user',
            username: 'test_isa',
            discriminator: '0002',
            relationship: 'Friend',
            online: true,
          },
        }}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.queryByTitle('Входящий звонок')).toBeNull()
  })

  it('marks active direct calls in the channel row', () => {
    syncStore.setVoiceCall({
      channelId: 'dm-call',
      initiatorId: 'caller-user',
      phase: 'active',
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: [],
      declinedRecipients: [],
    })

    render(
      <ChannelSidebarItem
        channel={directMessageChannel}
        activeChannelId="text-general"
        users={{
          'caller-user': {
            _id: 'caller-user',
            username: 'test_isa',
            discriminator: '0002',
            relationship: 'Friend',
            online: true,
          },
        }}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.getByTitle('Идёт звонок')).toBeTruthy()
  })

  it('does not mark active calls after hiding the same ringing phase', () => {
    const ringingCall = {
      channelId: 'dm-call',
      initiatorId: 'caller-user',
      phase: 'ringing' as const,
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: ['user-1'],
      declinedRecipients: [],
    }
    syncStore.dismissVoiceCall(ringingCall)
    syncStore.setVoiceCall({
      ...ringingCall,
      phase: 'active',
      recipients: [],
    })

    render(
      <ChannelSidebarItem
        channel={directMessageChannel}
        activeChannelId="text-general"
        users={{
          'caller-user': {
            _id: 'caller-user',
            username: 'test_isa',
            discriminator: '0002',
            relationship: 'Friend',
            online: true,
          },
        }}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.queryByTitle('Идёт звонок')).toBeNull()
  })

  it('renders group direct messages with a group icon in the channel row', () => {
    render(
      <ChannelSidebarItem
        channel={groupChannel}
        activeChannelId="group-call"
        users={{}}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.getByRole('link', { name: 'Команда' })).toBeTruthy()
    expect(screen.getByTitle('Групповой чат')).toBeTruthy()
  })
})
