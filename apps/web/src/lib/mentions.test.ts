import { describe, expect, it } from 'vitest'
import type { Message } from '@syrnike13/api-types'

import { isMessageMentioningUser } from '#/lib/mentions'

const me = '01KTAAAAAAAAAAAAAAAAAAAAAA01'
const author = '01KTBBBBBBBBBBBBBBBBBBBBBB01'

function message(overrides: Partial<Message> = {}): Message {
  return {
    _id: '01KTCCCCCCCCCCCCCCCCCCCCCC01',
    channel: 'channel-1',
    author,
    ...overrides,
  }
}

describe('isMessageMentioningUser', () => {
  it('detects direct user mentions', () => {
    expect(
      isMessageMentioningUser(
        message({ mentions: [me] }),
        me,
      ),
    ).toBe(true)
  })

  it('ignores own messages', () => {
    expect(
      isMessageMentioningUser(
        message({ author: me, mentions: [me] }),
        me,
      ),
    ).toBe(false)
  })

  it('detects role mentions for current member', () => {
    expect(
      isMessageMentioningUser(
        message({ role_mentions: ['role-1'] }),
        me,
        {
          member: {
            _id: { server: 's', user: me },
            joined_at: '2024-01-01T00:00:00Z',
            roles: ['role-1'],
          },
        },
      ),
    ).toBe(true)
  })

  it('falls back to content tokens', () => {
    expect(
      isMessageMentioningUser(
        message({ content: `hey <@${me}>`, mentions: null }),
        me,
      ),
    ).toBe(true)
  })
})
