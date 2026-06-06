import { describe, expect, it } from 'vitest'

import { messageDeepLink } from './message-link'

describe('messageDeepLink', () => {
  it('uses the public app origin instead of the current browser origin', () => {
    expect(messageDeepLink('channel-1', 'message 1')).toBe(
      'https://syrnike13.ru/app/c/channel-1?m=message%201',
    )
  })
})
