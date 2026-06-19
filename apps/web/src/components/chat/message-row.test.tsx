// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageRow } from '#/components/chat/message-row'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'
import { permissionOr } from '#/lib/permission-bits'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const CALLER_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'
const MESSAGE_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'

const caller = {
  _id: CALLER_ID,
  username: 'test_isa',
  online: true,
} as User

function callMessage(
  finishedAt?: string | null,
  endedReason?: 'completed' | 'cancelled' | 'missed',
): Message {
  return {
    _id: MESSAGE_ID,
    channel: CHANNEL_ID,
    author: '00000000000000000000000000',
    system: {
      type: 'call_started',
      by: CALLER_ID,
      finished_at: finishedAt,
      ended_reason: endedReason,
    },
  } as Message
}

function renderCallMessage(message: Message) {
  return render(
    <MessageRow
      message={message}
      channelId={CHANNEL_ID}
      users={{ [CALLER_ID]: caller }}
      emojis={{}}
      messagesById={{ [message._id]: message }}
    />,
  )
}

describe('MessageRow compact messages', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows edited marker on compact follow-up messages', () => {
    const author = {
      _id: 'author-user',
      username: 'author',
      online: true,
    } as User
    const message = {
      _id: MESSAGE_ID,
      channel: CHANNEL_ID,
      author: author._id,
      content: 'edited follow-up',
      edited: '2026-06-03T19:00:00.000Z',
    } as Message & { edited: string }

    render(
      <MessageRow
        message={message}
        channelId={CHANNEL_ID}
        users={{ [author._id]: author }}
        emojis={{}}
        messagesById={{ [message._id]: message }}
        compact
      />,
    )

    expect(screen.getByText('(изменено)')).toBeTruthy()
  })
})

describe('MessageRow moderation actions', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('lets channel moderators delete other users messages', () => {
    const onDelete = vi.fn()
    const otherUser = {
      _id: 'author-user',
      username: 'author',
      online: true,
    } as User
    const currentUser = {
      _id: 'moderator-user',
      username: 'moderator',
      online: true,
    } as User
    const message = {
      _id: MESSAGE_ID,
      channel: CHANNEL_ID,
      author: otherUser._id,
      content: 'moderate me',
    } as Message

    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-user',
      channels: [CHANNEL_ID],
      default_permissions: 0,
      roles: {
        moderator: {
          _id: 'moderator',
          name: 'Moderator',
          permissions: {
            a: permissionOr(
              ChannelPermission.ViewChannel,
              ChannelPermission.ManageMessages,
            ),
            d: 0,
          },
          rank: 1,
        },
      },
    } as never)
    syncStore.upsertChannel({
      _id: CHANNEL_ID,
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'general',
      default_permissions: null,
      role_permissions: {},
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: currentUser._id },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['moderator'],
      } as never,
    ])

    render(
      <MessageRow
        message={message}
        channelId={CHANNEL_ID}
        users={{ [otherUser._id]: otherUser, [currentUser._id]: currentUser }}
        emojis={{}}
        messagesById={{ [message._id]: message }}
        currentUserId={currentUser._id}
        serverId="server-1"
        onReply={vi.fn()}
        onDelete={onDelete}
        onToggleReaction={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    expect(onDelete).toHaveBeenCalledWith(message)
  })
})

describe('MessageRow system call messages', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('renders an active call system message like a user message row', () => {
    renderCallMessage(callMessage(null))

    expect(screen.getByLabelText('Неуспешный звонок')).toBeTruthy()
    expect(screen.queryByText('Звонок')).toBeNull()
    expect(screen.getByRole('button', { name: 'test_isa' })).toBeTruthy()
    expect(screen.getByText(/начал звонок · Идёт сейчас/)).toBeTruthy()
    expect(screen.queryByText('[системное сообщение]')).toBeNull()
  })

  it('renders a finished call system message with duration', () => {
    renderCallMessage(callMessage('2026-06-03T18:58:36.043Z', 'completed'))

    expect(screen.getByLabelText('Успешный звонок')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'test_isa' })).toBeTruthy()
    expect(screen.getByText(/начал звонок · Завершён · 3 мин/)).toBeTruthy()
  })

  it('renders a cancelled call system message with duration', () => {
    renderCallMessage(callMessage('2026-06-03T18:58:36.043Z', 'cancelled'))

    expect(screen.getByLabelText('Неуспешный звонок')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'test_isa' })).toBeTruthy()
    expect(screen.getByText(/начал звонок · Отменён · 3 мин/)).toBeTruthy()
  })

  it('renders a missed call system message with duration', () => {
    renderCallMessage(callMessage('2026-06-03T18:58:36.043Z', 'missed'))

    expect(screen.getByLabelText('Неуспешный звонок')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'test_isa' })).toBeTruthy()
    expect(screen.getByText(/начал звонок · Пропущен · 3 мин/)).toBeTruthy()
  })
})
