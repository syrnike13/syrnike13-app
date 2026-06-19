import type { Message } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import {
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
