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
import type { Channel, Message, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelChatPanel } from '#/components/chat/channel-chat-panel'

const CURRENT_USER_ID = 'current-user'
const TARGET_USER_ID = 'target-user'
const CHANNEL_ID = 'dm-1'

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
} as User

const directMessageChannel = {
  _id: CHANNEL_ID,
  channel_type: 'DirectMessage',
  active: true,
  recipients: [CURRENT_USER_ID, TARGET_USER_ID],
} as Channel

const chatState = vi.hoisted(() => ({
  channel: undefined as Channel | undefined,
  users: {} as Record<string, User>,
}))
const chatActions = vi.hoisted(() => ({
  handleDelete: vi.fn(),
  handlePin: vi.fn(),
  handleUnpin: vi.fn(),
  handleClearReactions: vi.fn(),
  jumpToMessage: vi.fn(),
  setComposerAction: vi.fn(),
  notifyTyping: vi.fn(),
}))
const friendActionMocks = vi.hoisted(() => ({
  blockUserRelationship: vi.fn().mockResolvedValue(undefined),
}))
const messageListMessage = vi.hoisted(
  () =>
    ({
      _id: 'message-1',
      channel: 'dm-1',
      author: 'target-user',
      content: 'hello',
      reactions: {
        wave: ['current-user'],
      },
    }) as Message,
)

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
    setComposerAction: chatActions.setComposerAction,
    hasOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    handleDelete: chatActions.handleDelete,
    handlePin: chatActions.handlePin,
    handleUnpin: chatActions.handleUnpin,
    handleClearReactions: chatActions.handleClearReactions,
    canClearMessageReactions: true,
    jumpToMessage: chatActions.jumpToMessage,
    replyTo: null,
    editingMessage: null,
    listHighlightMessageId: undefined,
    notifyTyping: chatActions.notifyTyping,
  }),
}))

vi.mock('#/features/friends/friend-actions', () => ({
  blockUserRelationship: friendActionMocks.blockUserRelationship,
}))

vi.mock('#/features/api/messages-api', () => ({
  editChannelMessage: vi.fn(),
  reactToMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  unreactFromMessage: vi.fn(),
}))

vi.mock('#/components/chat/message-list', () => ({
  MessageList: ({
    onDelete,
    onBlock,
    onClearReactions,
  }: {
    onDelete?: (message: Message) => void
    onBlock?: (message: Message) => void
    onClearReactions?: (message: Message) => void
  }) => (
    <div data-testid="message-list">
      <button type="button" onClick={() => onDelete?.(messageListMessage)}>
        Delete message
      </button>
      <button type="button" onClick={() => onBlock?.(messageListMessage)}>
        Block message author
      </button>
      <button
        type="button"
        onClick={() => onClearReactions?.(messageListMessage)}
      >
        Clear reactions
      </button>
    </div>
  ),
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
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
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}))

vi.mock('#/components/channels/channel-settings-dialog', () => ({
  ChannelSettingsDialog: () => null,
}))

vi.mock('#/components/chat/channel-pinned-dialog', () => ({
  ChannelPinnedDialog: () => null,
}))

vi.mock('#/components/chat/channel-search-dialog', () => ({
  ChannelSearchDialog: () => null,
}))

vi.mock('#/components/chat/message-composer', () => ({
  MessageComposer: () => <div data-testid="message-composer" />,
}))

vi.mock('#/components/chat/typing-indicator', () => ({
  TypingIndicator: () => null,
}))

function renderPanel() {
  render(<ChannelChatPanel channelId={CHANNEL_ID} onClose={vi.fn()} />)
}

describe('ChannelChatPanel message action confirmations', () => {
  beforeEach(() => {
    chatState.channel = directMessageChannel
    chatState.users = {
      [CURRENT_USER_ID]: currentUser,
      [TARGET_USER_ID]: targetUser,
    }
    chatActions.handleDelete.mockClear()
    chatActions.handlePin.mockClear()
    chatActions.handleUnpin.mockClear()
    chatActions.handleClearReactions.mockClear()
    chatActions.jumpToMessage.mockClear()
    chatActions.setComposerAction.mockClear()
    chatActions.notifyTyping.mockClear()
    friendActionMocks.blockUserRelationship.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('confirms deleting a chat message before calling the delete handler', () => {
    const confirmMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmMock)

    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))

    expect(confirmMock).not.toHaveBeenCalled()
    expect(chatActions.handleDelete).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Удалить сообщение?')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }))

    expect(chatActions.handleDelete).toHaveBeenCalledWith(messageListMessage)
  })

  it('confirms clearing reactions before calling the clear handler', () => {
    const confirmMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmMock)

    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Clear reactions' }))

    expect(confirmMock).not.toHaveBeenCalled()
    expect(chatActions.handleClearReactions).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Очистить реакции?')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Очистить' }))

    expect(chatActions.handleClearReactions).toHaveBeenCalledWith(
      messageListMessage,
    )
  })

  it('confirms blocking a message author before calling the block action', async () => {
    const confirmMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmMock)

    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Block message author' }))

    expect(confirmMock).not.toHaveBeenCalled()
    expect(friendActionMocks.blockUserRelationship).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/test_isa/)).toBeTruthy()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Заблокировать' }),
    )

    await waitFor(() => {
      expect(friendActionMocks.blockUserRelationship).toHaveBeenCalledWith(
        'session-token',
        TARGET_USER_ID,
      )
    })
  })
})
