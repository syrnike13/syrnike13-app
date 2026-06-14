// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Channel, Member, Server, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelView } from '#/components/chat/channel-view'
import { syncStore } from '#/features/sync/sync-store'

const CURRENT_USER_ID = 'current-user'
const TARGET_USER_ID = 'target-user'
const CHANNEL_ID = 'dm-1'
const GROUP_CHANNEL_ID = 'group-1'
const voiceJoinMock = vi.hoisted(() => vi.fn())
const cancelDirectMessageCallMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const declineDirectMessageCallMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const voiceState = vi.hoisted(() => ({
  channelId: null as string | null,
  status: 'idle' as 'idle' | 'connecting' | 'connected',
}))
const chatState = vi.hoisted(() => ({
  channel: undefined as Channel | undefined,
  users: {} as Record<string, User>,
}))

class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const currentUser = {
  _id: CURRENT_USER_ID,
  username: 'me',
  discriminator: '0001',
  relationship: 'User',
  online: true,
} as User

const targetUser = {
  _id: TARGET_USER_ID,
  username: 'test_isa',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
  status: {
    presence: 'Idle',
  },
} as User

const directMessageChannel = {
  _id: CHANNEL_ID,
  channel_type: 'DirectMessage',
  active: true,
  recipients: [CURRENT_USER_ID, TARGET_USER_ID],
} as Channel

const groupChannel = {
  _id: GROUP_CHANNEL_ID,
  channel_type: 'Group',
  active: true,
  name: 'Команда',
  owner: CURRENT_USER_ID,
  recipients: [CURRENT_USER_ID, TARGET_USER_ID],
} as Channel

vi.mock('#/features/chat/use-channel-chat', () => ({
  useChannelChat: () => ({
    auth: {
      user: currentUser,
      session: { token: 'session-token' },
      gatewayState: 'connected',
    },
    channel: chatState.channel,
    users: chatState.users,
    messages: [],
    token: 'session-token',
    historyQuery: { isFetching: false },
    serverIdForSelection: null,
    isServerChannel: false,
    setComposerAction: vi.fn(),
    hasOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    handleDelete: vi.fn(),
    handlePin: vi.fn(),
    handleUnpin: vi.fn(),
    jumpToMessage: vi.fn(),
    replyTo: null,
    editingMessage: null,
    listHighlightMessageId: undefined,
    notifyTyping: vi.fn(),
  }),
}))

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => ({
    channelId: voiceState.channelId,
    status: voiceState.status,
    join: voiceJoinMock,
  }),
}))

vi.mock('#/features/api/channels-api', () => ({
  cancelDirectMessageCall: cancelDirectMessageCallMock,
  declineDirectMessageCall: declineDirectMessageCallMock,
}))

vi.mock('#/components/voice/voice-channel-shell', () => ({
  VoiceChannelShell: ({ channelId }: { channelId: string }) => (
    <div data-testid="voice-channel-shell">{channelId}</div>
  ),
}))

vi.mock('#/components/voice/voice-stage-view', () => ({
  VoiceStageView: ({
    channel,
    title,
    dmHeader,
    headerTrailing,
    voiceCallIncoming,
    onDeclineVoiceCall,
  }: {
    channel: Channel
    title: string
    dmHeader?: unknown
    headerTrailing?: ReactNode
    voiceCallIncoming?: boolean
    onDeclineVoiceCall?: () => void
  }) => (
    <div data-testid="inline-voice-stage">
      <span data-testid="inline-voice-stage-title">{title}</span>
      {dmHeader ? <span data-testid="inline-voice-stage-dm-header" /> : null}
      {headerTrailing ? (
        <span data-testid="inline-voice-stage-header-trailing" />
      ) : null}
      {voiceCallIncoming ? (
        <>
          <button
            type="button"
            onClick={() => voiceJoinMock(channel._id)}
          >
            Ответить
          </button>
          <button type="button" onClick={onDeclineVoiceCall}>
            Отклонить
          </button>
        </>
      ) : null}
    </div>
  ),
}))

vi.mock('#/components/voice/voice-text-channel-dock', () => ({
  VoiceTextChannelDock: () => <div data-testid="voice-text-channel-dock" />,
}))

vi.mock('#/components/chat/message-list', () => ({
  MessageList: () => <div data-testid="message-list" />,
}))

vi.mock('#/components/chat/message-composer', () => ({
  MessageComposer: () => <div data-testid="message-composer" />,
}))

vi.mock('#/components/chat/typing-indicator', () => ({
  TypingIndicator: () => null,
}))

vi.mock('#/components/chat/channel-pinned-dialog', () => ({
  ChannelPinnedDialog: () => null,
}))

vi.mock('#/components/chat/channel-search-dialog', () => ({
  ChannelSearchDialog: () => null,
}))

vi.mock('#/components/user/user-global-profile-dialog', () => ({
  UserGlobalProfileDialog: ({
    open,
    user,
  }: {
    open: boolean
    user: User
  }) =>
    open ? (
      <div role="dialog" aria-label={`Профиль ${user.display_name ?? user.username}`} />
    ) : null,
}))

vi.mock('#/features/api/users-api', async () => {
  const actual = await vi.importActual<typeof import('#/features/api/users-api')>(
    '#/features/api/users-api',
  )

  return {
    ...actual,
    fetchUserProfile: vi.fn().mockResolvedValue({
      content: null,
      background: null,
    }),
  }
})

function server(id: string, name: string): Server {
  return {
    _id: id,
    name,
    owner: CURRENT_USER_ID,
    default_permissions: 0,
  } as Server
}

function member(
  serverId: string,
  userId: string,
  nickname?: string | null,
): Member {
  return {
    _id: {
      server: serverId,
      user: userId,
    },
    nickname,
  } as Member
}

function renderChannelView(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>,
  )
}

describe('ChannelView direct message header', () => {
  beforeEach(() => {
    voiceJoinMock.mockClear()
    cancelDirectMessageCallMock.mockClear()
    declineDirectMessageCallMock.mockClear()
    voiceState.channelId = null
    voiceState.status = 'idle'
    chatState.channel = directMessageChannel
    chatState.users = {
      [CURRENT_USER_ID]: currentUser,
      [TARGET_USER_ID]: targetUser,
    }
    syncStore.reset()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    syncStore.applyReady({
      users: [currentUser, targetUser],
      servers: [
        server('server-a', 'Alpha'),
        server('server-b', 'Beta'),
      ],
      channels: [directMessageChannel],
      members: [
        member('server-a', CURRENT_USER_ID),
        member('server-a', TARGET_USER_ID, 'Хан батый'),
        member('server-b', CURRENT_USER_ID),
        member('server-b', TARGET_USER_ID, 'Андрей'),
      ],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.unstubAllGlobals()
  })

  it('renders avatar, presence dot, name, and mutual server aliases', () => {
    const { container } = renderChannelView(
      <ChannelView channelId={CHANNEL_ID} />,
    )
    const header = container.querySelector('header')

    expect(header).toBeTruthy()

    expect(within(header!).getByText('T')).toBeTruthy()
    expect(within(header!).getByTitle('Не активен')).toBeTruthy()
    expect(within(header!).getByRole('heading', { name: 'test_isa' })).toBeTruthy()
    expect(within(header!).getByText('AKA')).toBeTruthy()
    expect(within(header!).getByText('Хан батый, Андрей')).toBeTruthy()
    expect(within(header!).queryByText('не активен')).toBeNull()
  })

  it('opens the direct message profile panel by default and toggles it from the header', () => {
    renderChannelView(<ChannelView channelId={CHANNEL_ID} />)

    const panel = screen.getByLabelText('Профиль пользователя')
    expect(
      within(panel).getByRole('heading', { name: 'test_isa' }),
    ).toBeTruthy()
    expect(within(panel).getByText('Общие серверы — 2')).toBeTruthy()
    expect(within(panel).getByText('Хан батый, Андрей')).toBeTruthy()

    const profileButton = screen.getByRole('button', { name: 'Скрыть профиль' })
    expect(profileButton.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(profileButton)
    expect(screen.queryByLabelText('Профиль пользователя')).toBeNull()
    expect(profileButton.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(profileButton)
    expect(screen.getByLabelText('Профиль пользователя')).toBeTruthy()
    expect(profileButton.getAttribute('aria-pressed')).toBe('true')
  })

  it('opens the global profile dialog when the profile panel avatar is clicked', () => {
    renderChannelView(<ChannelView channelId={CHANNEL_ID} />)

    const panel = screen.getByLabelText('Профиль пользователя')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(panel).getByTitle('Открыть профиль'))

    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('opens the global profile dialog when the header name is clicked', () => {
    const { container } = renderChannelView(
      <ChannelView channelId={CHANNEL_ID} />,
    )
    const header = container.querySelector('header')

    expect(header).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(header!).getByRole('button', { name: 'test_isa' }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('Профиль пользователя')).toBeTruthy()
  })

  it('starts a direct message call from the header call button', () => {
    const { container } = renderChannelView(
      <ChannelView channelId={CHANNEL_ID} />,
    )
    const header = container.querySelector('header')

    expect(header).toBeTruthy()

    fireEvent.click(within(header!).getByRole('button', { name: 'Позвонить' }))

    expect(voiceJoinMock).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('renders a group direct message header with group identity controls', () => {
    chatState.channel = groupChannel
    syncStore.reset()
    syncStore.applyReady({
      users: [currentUser, targetUser],
      servers: [],
      channels: [groupChannel],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    const { container } = renderChannelView(
      <ChannelView channelId={GROUP_CHANNEL_ID} />,
    )
    const header = container.querySelector('header')

    expect(header).toBeTruthy()
    expect(within(header!).getByTitle('Групповой чат')).toBeTruthy()
    expect(within(header!).getByRole('heading', { name: 'Команда' })).toBeTruthy()
    expect(within(header!).queryByRole('button', { name: 'Профиль' })).toBeNull()

    fireEvent.click(within(header!).getByRole('button', { name: 'Позвонить' }))
    expect(voiceJoinMock).toHaveBeenCalledWith(GROUP_CHANNEL_ID)
  })

  it('keeps a hidden ringing group call joinable from the header', () => {
    chatState.channel = groupChannel
    syncStore.reset()
    syncStore.applyReady({
      users: [currentUser, targetUser],
      servers: [],
      channels: [groupChannel],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)
    const call = {
      channelId: GROUP_CHANNEL_ID,
      initiatorId: TARGET_USER_ID,
      phase: 'ringing' as const,
      startedAt: 1,
      recipients: [CURRENT_USER_ID],
      declinedRecipients: [],
    }
    syncStore.setVoiceCall(call)
    syncStore.dismissVoiceCall(call)

    const { container } = renderChannelView(
      <ChannelView channelId={GROUP_CHANNEL_ID} />,
    )
    const header = container.querySelector('header')

    expect(header).toBeTruthy()
    expect(
      within(header!).queryByRole('button', { name: 'Позвонить' }),
    ).toBeNull()
    fireEvent.click(
      within(header!).getByRole('button', { name: 'Присоединиться' }),
    )
    expect(voiceJoinMock).toHaveBeenCalledWith(GROUP_CHANNEL_ID)
  })

  it('shows an inline voice stage with chat while connected', () => {
    voiceState.channelId = CHANNEL_ID
    voiceState.status = 'connected'

    const { container } = renderChannelView(<ChannelView channelId={CHANNEL_ID} />)

    expect(container.querySelector('header')).toBeNull()
    expect(screen.queryByTestId('voice-channel-shell')).toBeNull()
    expect(screen.queryByTestId('voice-text-channel-dock')).toBeNull()
    expect(screen.getByTestId('inline-voice-stage-title').textContent).toBe(
      'test_isa',
    )
    expect(screen.getByTestId('inline-voice-stage-dm-header')).toBeTruthy()
    expect(screen.getByTestId('inline-voice-stage-header-trailing')).toBeTruthy()
    expect(screen.getByLabelText('Голосовой звонок')).toBeTruthy()
    expect(screen.getByLabelText('Изменить высоту звонка')).toBeTruthy()
    expect(screen.getByTestId('message-list')).toBeTruthy()
    expect(screen.queryByLabelText('Профиль пользователя')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Скрыть профиль' }),
    ).toBeNull()
  })

  it('keeps group direct message chat visible with an inline voice stage while connected', () => {
    chatState.channel = groupChannel
    voiceState.channelId = GROUP_CHANNEL_ID
    voiceState.status = 'connected'
    syncStore.reset()
    syncStore.applyReady({
      users: [currentUser, targetUser],
      servers: [],
      channels: [groupChannel],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    renderChannelView(<ChannelView channelId={GROUP_CHANNEL_ID} />)

    expect(screen.queryByTestId('voice-channel-shell')).toBeNull()
    expect(screen.queryByTestId('voice-text-channel-dock')).toBeNull()
    expect(screen.getByTestId('inline-voice-stage').textContent).toBe('Команда')
    expect(screen.getByTestId('message-list')).toBeTruthy()
  })

  it('shows an active direct message call as an inline voice stage before joining', () => {
    syncStore.handleGatewayEvent({
      type: 'VoiceCallActive',
      channel_id: CHANNEL_ID,
      initiator_id: TARGET_USER_ID,
      started_at: 1,
    })

    const { container } = renderChannelView(<ChannelView channelId={CHANNEL_ID} />)

    expect(container.querySelector('header')).toBeNull()
    expect(screen.queryByText('Звонок уже идёт')).toBeNull()
    expect(screen.getByTestId('inline-voice-stage-dm-header')).toBeTruthy()
    expect(screen.getByTestId('inline-voice-stage-title').textContent).toBe(
      'test_isa',
    )
    expect(screen.getByTestId('message-list')).toBeTruthy()
    expect(screen.queryByLabelText('Профиль пользователя')).toBeNull()
  })

  it('keeps an inline voice stage visible after a dismissed ring becomes active', () => {
    chatState.channel = groupChannel
    syncStore.reset()
    syncStore.applyReady({
      users: [currentUser, targetUser],
      servers: [],
      channels: [groupChannel],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)
    const call = {
      channelId: GROUP_CHANNEL_ID,
      initiatorId: TARGET_USER_ID,
      phase: 'ringing' as const,
      startedAt: 1,
      recipients: [CURRENT_USER_ID],
      declinedRecipients: [],
    }
    syncStore.setVoiceCall(call)
    syncStore.dismissVoiceCall(call)
    syncStore.setVoiceCall({
      ...call,
      phase: 'active',
      recipients: [],
    })

    renderChannelView(<ChannelView channelId={GROUP_CHANNEL_ID} />)

    expect(screen.getByTestId('inline-voice-stage').textContent).toBe('Команда')
    expect(screen.getByLabelText('Голосовой звонок')).toBeTruthy()
    expect(screen.queryByText('Звонок уже идёт')).toBeNull()
    expect(screen.getByRole('button', { name: 'Присоединиться' })).toBeTruthy()
  })

  it('shows and declines an incoming direct message call on the inline stage', async () => {
    syncStore.handleGatewayEvent({
      type: 'VoiceCallRinging',
      channel_id: CHANNEL_ID,
      initiator_id: TARGET_USER_ID,
      started_at: 1,
      recipients: [CURRENT_USER_ID],
    })

    const { container } = renderChannelView(<ChannelView channelId={CHANNEL_ID} />)

    expect(container.querySelector('header')).toBeNull()
    expect(screen.getByTestId('inline-voice-stage-title').textContent).toBe(
      'test_isa',
    )
    expect(screen.getByTestId('inline-voice-stage-dm-header')).toBeTruthy()
    expect(screen.getByLabelText('Голосовой звонок')).toBeTruthy()
    expect(screen.queryByText('Личный звонок')).toBeNull()
    expect(screen.queryByLabelText('Профиль пользователя')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))
    expect(voiceJoinMock).toHaveBeenCalledWith(CHANNEL_ID)

    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))
    expect(declineDirectMessageCallMock).toHaveBeenCalledWith(
      'session-token',
      CHANNEL_ID,
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Голосовой звонок')).toBeTruthy()
    })
    expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toMatchObject({
      phase: 'active',
      declinedRecipients: [CURRENT_USER_ID],
    })
  })

  it('keeps the inline direct message call ringing when decline fails', async () => {
    declineDirectMessageCallMock.mockRejectedValueOnce(new Error('boom'))
    syncStore.handleGatewayEvent({
      type: 'VoiceCallRinging',
      channel_id: CHANNEL_ID,
      initiator_id: TARGET_USER_ID,
      started_at: 1,
      recipients: [CURRENT_USER_ID],
    })

    renderChannelView(<ChannelView channelId={CHANNEL_ID} />)

    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))

    await waitFor(() => {
      expect(declineDirectMessageCallMock).toHaveBeenCalledWith(
        'session-token',
        CHANNEL_ID,
      )
    })
    expect(screen.getByLabelText('Голосовой звонок')).toBeTruthy()
  })

})
