import type { Message } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import {
  buildMessageFeedItems,
  feedItemEstimateHeight,
  type MessageFeedItem,
} from '#/lib/message-feed'

const MESSAGE_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MINUTE_MS = 60 * 1000

function ulidAt(timeMs: number, tail: string) {
  let value = timeMs
  let timestamp = ''

  for (let index = 0; index < 10; index += 1) {
    timestamp = ULID_ENCODING[value % 32]! + timestamp
    value = Math.floor(value / 32)
  }

  return `${timestamp}${tail.padEnd(16, '0')}`.slice(0, 26)
}

function messageAt(timeMs: number, tail: string): Message {
  return {
    _id: ulidAt(timeMs, tail),
    channel: 'channel-id',
    author: 'user-id',
    content: 'hello',
  } as Message
}

function messageCompactStates(messages: Message[]) {
  return buildMessageFeedItems(messages)
    .filter((item) => item.type === 'message')
    .map((item) => item.compact)
}

describe('message feed grouping', () => {
  it('compacts same-author messages only inside the grouping window', () => {
    const firstAt = Date.UTC(2026, 0, 1, 12, 0, 0)

    expect(
      messageCompactStates([
        messageAt(firstAt, 'A'),
        messageAt(firstAt + 6 * MINUTE_MS, 'B'),
      ]),
    ).toEqual([false, true])

    expect(
      messageCompactStates([
        messageAt(firstAt, 'C'),
        messageAt(firstAt + 8 * MINUTE_MS, 'D'),
      ]),
    ).toEqual([false, false])
  })
})

describe('message feed unread divider', () => {
  it('inserts a new messages divider before the first unread message', () => {
    const firstAt = Date.UTC(2026, 0, 1, 12, 0, 0)
    const readMessage = messageAt(firstAt, 'A')
    const unreadMessage = messageAt(firstAt + MINUTE_MS, 'B')

    expect(
      buildMessageFeedItems([readMessage, unreadMessage], readMessage._id).map(
        (item) => item.type,
      ),
    ).toEqual(['date', 'message', 'unread', 'message'])
  })

  it('does not insert a divider when the channel is already read', () => {
    const firstAt = Date.UTC(2026, 0, 1, 12, 0, 0)
    const readMessage = messageAt(firstAt, 'A')
    const lastMessage = messageAt(firstAt + MINUTE_MS, 'B')

    expect(
      buildMessageFeedItems([readMessage, lastMessage], lastMessage._id).map(
        (item) => item.type,
      ),
    ).toEqual(['date', 'message', 'message'])
  })
})

describe('message feed item height estimates', () => {
  it('estimates call system cards taller than regular messages', () => {
    const item: MessageFeedItem = {
      type: 'message',
      key: MESSAGE_ID,
      compact: false,
      message: {
        _id: MESSAGE_ID,
        channel: 'channel-id',
        author: '00000000000000000000000000',
        system: {
          type: 'call_started',
          by: 'user-id',
          finished_at: null,
        },
      } as Message,
    }

    expect(feedItemEstimateHeight(item)).toBe(104)
  })
})
