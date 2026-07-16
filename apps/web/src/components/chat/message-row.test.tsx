// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageRow } from '#/components/chat/message-row'

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

function textMessage(): Message {
  return {
    _id: MESSAGE_ID,
    channel: CHANNEL_ID,
    author: CALLER_ID,
    content: 'hello',
  } as Message
}

describe('MessageRow system call messages', () => {
  afterEach(() => {
    cleanup()
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

describe('MessageRow context menu', () => {
  afterEach(() => {
    cleanup()
  })

  it('opens a reply action on right click', async () => {
    const onReply = vi.fn()
    const message = textMessage()

    render(
      <MessageRow
        message={message}
        channelId={CHANNEL_ID}
        users={{ [CALLER_ID]: caller }}
        emojis={{}}
        messagesById={{ [message._id]: message }}
        onReply={onReply}
      />,
    )

    fireEvent.contextMenu(screen.getByText('hello'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ответить' }))

    expect(onReply).toHaveBeenCalledWith(message)
  })
})
