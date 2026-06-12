// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

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

describe('MessageRow system call messages', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders an active call system message as a call card', () => {
    renderCallMessage(callMessage(null))

    expect(screen.getByText('Звонок')).toBeTruthy()
    expect(screen.getByText('test_isa начал звонок')).toBeTruthy()
    expect(screen.getByText('Идёт сейчас')).toBeTruthy()
    expect(screen.queryByText('[системное сообщение]')).toBeNull()
  })

  it('renders a finished call system message with duration', () => {
    renderCallMessage(callMessage('2026-06-03T18:58:36.043Z', 'completed'))

    expect(screen.getByText('Звонок')).toBeTruthy()
    expect(screen.getByText('test_isa начал звонок')).toBeTruthy()
    expect(screen.getByText('Завершён · 3 мин')).toBeTruthy()
  })

  it('renders a cancelled call system message with duration', () => {
    renderCallMessage(callMessage('2026-06-03T18:58:36.043Z', 'cancelled'))

    expect(screen.getByText('Звонок')).toBeTruthy()
    expect(screen.getByText('test_isa начал звонок')).toBeTruthy()
    expect(screen.getByText('Отменён · 3 мин')).toBeTruthy()
  })

  it('renders a missed call system message with duration', () => {
    renderCallMessage(callMessage('2026-06-03T18:58:36.043Z', 'missed'))

    expect(screen.getByText('Звонок')).toBeTruthy()
    expect(screen.getByText('test_isa начал звонок')).toBeTruthy()
    expect(screen.getByText('Пропущен · 3 мин')).toBeTruthy()
  })
})
