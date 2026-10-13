import type { Message } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import {
  buildMessageFeedItems,
  feedItemEstimateHeight,
  type MessageFeedItem,
} from '#/lib/message-feed'

const MESSAGE_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'

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

const AUTHOR = '00000000000000000000000000'

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

  it('estimates an embed card taller than a plain row', () => {
    const item: MessageFeedItem = {
      type: 'message',
      key: '01KT7DEM3B0T4B0BXGBXWDJ711',
      compact: false,
      message: embedMessage('01KT7DEM3B0T4B0BXGBXWDJ711'),
    }

    expect(feedItemEstimateHeight(item)).toBe(240)
  })
})
