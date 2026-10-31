import type { Message } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import { buildMessageFeedItems } from './message-feed'

const AUTHOR = '00000000000000000000000000'
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function ulidAt(timestampMs: number, suffix = '0000000000000000') {
  let time = timestampMs
  let encoded = ''
  for (let index = 0; index < 10; index += 1) {
    encoded = ULID_ENCODING[time % 32]! + encoded
    time = Math.floor(time / 32)
  }
  return encoded + suffix
}

function textMessage(id: string, content: string): Message {
  return { _id: id, channel: 'channel-id', author: AUTHOR, content } as Message
}

function embedMessage(id: string): Message {
  return {
    _id: id,
    channel: 'channel-id',
    author: AUTHOR,
    embeds: [
      {
        type: 'Image',
        url: 'https://cdn.example.com/photo.jpg',
        width: 800,
        height: 600,
        size: 'Large',
      },
    ],
  } as Message
}

describe('message feed grouping around embeds', () => {
  it('does not compact the message with the embed or the one after it', () => {
    const items = buildMessageFeedItems([
      textMessage('01KT7DEM3B0T4B0BXGBXWDJ710', 'смотри'),
      embedMessage('01KT7DEM3B0T4B0BXGBXWDJ711'),
      textMessage('01KT7DEM3B0T4B0BXGBXWDJ712', 'и вот'),
    ])

    const rows = items.filter((item) => item.type === 'message')
    expect(rows).toHaveLength(3)
    // Карточка embed рвёт группу с обеих сторон: ни она, ни соседние строки не «хвост».
    expect(
      rows.every((item) => item.type === 'message' && item.compact === false),
    ).toBe(true)
  })
})

describe('message feed grouping by time', () => {
  const base = Date.UTC(2026, 4, 12, 10, 0, 0)

  it('compacts consecutive messages within seven minutes', () => {
    const items = buildMessageFeedItems([
      textMessage(ulidAt(base), 'one'),
      textMessage(ulidAt(base + 6 * 60_000, 'A'), 'two'),
    ])

    const rows = items.filter((item) => item.type === 'message')
    expect(rows[1]).toMatchObject({ type: 'message', compact: true })
  })

  it('breaks the group after seven minutes', () => {
    const items = buildMessageFeedItems([
      textMessage(ulidAt(base), 'one'),
      textMessage(ulidAt(base + 8 * 60_000, 'B'), 'two'),
    ])

    const rows = items.filter((item) => item.type === 'message')
    expect(rows[1]).toMatchObject({ type: 'message', compact: false })
  })
})

describe('message feed unread marker', () => {
  it('inserts the unread divider before the first unread message', () => {
    const first = textMessage(ulidAt(1_700_000_000_000), 'read')
    const second = textMessage(ulidAt(1_700_000_001_000, 'C'), 'unread')

    const items = buildMessageFeedItems([first, second], {
      unreadMessageId: second._id,
    })

    expect(items.map((item) => item.type)).toEqual([
      'date',
      'message',
      'unread',
      'message',
    ])
    expect(items[2]).toMatchObject({
      type: 'unread',
      messageId: second._id,
    })
  })
})
