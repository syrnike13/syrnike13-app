// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'
import * as voiceChannelChatIntent from '#/features/voice/voice-channel-chat-intent'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  join: vi.fn(async () => {}),
  openVoiceChannelDrawer: vi.fn(),
  deleteChannel: vi.fn(async () => {}),
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

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/features/api/channels-api', () => ({
  deleteChannel: (...args: [string, string]) => mocks.deleteChannel(...args),
}))

vi.mock('#/features/api/sync-api', () => ({
  ackChannel: vi.fn(),
}))

vi.mock('#/features/api/invites-api', () => ({
  createChannelInvite: vi.fn(),
}))

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}))

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => mocks.voice,
}))

vi.mock('#/features/navigation/mobile-voice-channel-drawer-context', () => ({
  useOptionalMobileVoiceChannelDrawer: () => ({
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
  ContextMenuSeparator: () => null,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
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

const voiceChannel = {
  _id: 'voice-main',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'main',
  voice: { max_users: null },
} as Channel

const textServerChannel = {
  _id: 'text-general',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'general',
  description: null,
  nsfw: false,
  slowmode: 0,
  default_permissions: null,
} satisfies Extract<Channel, { channel_type: 'TextChannel' }>

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

function upsertTextServerChannel(channel = textServerChannel) {
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner: 'user-1',
    channels: [channel._id],
    default_permissions: 0,
  } as never)
  syncStore.upsertMembers([
    {
      _id: { server: 'server-1', user: 'user-1' },
      joined_at: '2024-01-01T00:00:00Z',
    } as never,
  ])
  syncStore.upsertChannel(channel)
}

describe('ChannelSidebarItem voice navigation', () => {
  beforeEach(() => {
    syncStore.reset()
    mocks.navigate.mockClear()
    mocks.join.mockClear()
    mocks.openVoiceChannelDrawer.mockClear()
    mocks.deleteChannel.mockResolvedValue(undefined)
    mocks.deleteChannel.mockClear()
    mocks.pathname = '/app/'
    mocks.voice.channelId = 'voice-main'
    mocks.voice.status = 'connected'
    mocks.voice.join = mocks.join
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
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

  it('joins the voice channel without opening the voice screen', () => {
    mocks.voice.channelId = null
    mocks.voice.status = 'idle'
    renderVoiceItem('text-general')

    fireEvent.click(screen.getByRole('link', { name: 'main' }))

    expect(mocks.join).toHaveBeenCalledWith('voice-main')
    expect(mocks.navigate).not.toHaveBeenCalled()
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

  it('opens voice channel chat from the sidebar action button', () => {
    const requestOpen = vi.spyOn(
      voiceChannelChatIntent,
      'requestVoiceChannelChatOpen',
    )

    renderVoiceItem('text-general')

    fireEvent.click(screen.getByRole('button', { name: 'Открыть чат' }))

    expect(requestOpen).toHaveBeenCalledWith('voice-main')
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'voice-main' },
      search: { m: undefined },
    })
    expect(mocks.join).not.toHaveBeenCalled()

    requestOpen.mockRestore()
  })

  it('opens voice channel chat without navigating when already active', () => {
    const requestOpen = vi.spyOn(
      voiceChannelChatIntent,
      'requestVoiceChannelChatOpen',
    )

    renderVoiceItem('voice-main')

    fireEvent.click(screen.getByRole('button', { name: 'Открыть чат' }))

    expect(requestOpen).toHaveBeenCalledWith('voice-main')
    expect(mocks.navigate).not.toHaveBeenCalled()

    requestOpen.mockRestore()
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

  it('marks restricted text channels with a locked text icon', () => {
    const channel = {
      ...textServerChannel,
      _id: 'text-private',
      name: 'private',
      default_permissions: {
        a: 0,
        d: ChannelPermission.ViewChannel,
      },
    } satisfies Extract<Channel, { channel_type: 'TextChannel' }>

    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'other-user',
      channels: [channel._id],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])
    syncStore.upsertChannel(channel)

    render(
      <ChannelSidebarItem
        channel={channel}
        activeChannelId="other-channel"
        users={{}}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.getByRole('link', { name: 'private' })).toBeTruthy()
    expect(screen.getByTitle('Закрытый текстовый канал')).toBeTruthy()
  })

  it('shows mention counts in inactive channel rows', () => {
    const channel = {
      ...textServerChannel,
      last_message_id: 'message-3',
    } satisfies Extract<Channel, { channel_type: 'TextChannel' }>

    upsertTextServerChannel(channel)
    syncStore.setUnreads([
      {
        _id: { channel: channel._id, user: 'user-1' },
        last_id: 'message-3',
        mentions: ['message-2', 'message-3'],
      },
    ])

    render(
      <ChannelSidebarItem
        channel={channel}
        activeChannelId="other-channel"
        users={{}}
        currentUserId="user-1"
        unreads={{}}
      />,
    )

    expect(screen.getByText('2')).toBeTruthy()
  })

  it('opens a delete confirmation dialog from the channel context menu', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    upsertTextServerChannel()

    render(
      <ChannelSidebarItem
        channel={textServerChannel}
        activeChannelId="other-channel"
        users={{}}
        currentUserId="user-1"
        unreads={{}}
        canManage
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить канал' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.deleteChannel).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('general')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Удалить канал' }),
    )

    await waitFor(() => {
      expect(mocks.deleteChannel).toHaveBeenCalledWith(
        'session-token',
        'text-general',
      )
    })
    expect(syncStore.getState().channels['text-general']).toBeUndefined()
  })
})
