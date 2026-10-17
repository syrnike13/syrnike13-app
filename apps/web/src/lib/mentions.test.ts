import { describe, expect, it } from 'vitest'
import type { Message, User } from '@syrnike13/api-types'

import { isMessageMentioningUser } from '#/lib/mentions'

const me = '01KTAAAAAAAAAAAAAAAAAAAAAA01'
const author = '01KTBBBBBBBBBBBBBBBBBBBBBB01'

function user(overrides: Partial<User> = {}): User {
  return {
    _id: me,
    username: 'alice',
    discriminator: '0001',
    online: true,
    ...overrides,
  } as User
}

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

  it('reads @everyone from the flag bit, not from the raw value', () => {
    // MessageFlags::MentionsEveryone = 2 — это индекс бита, то есть маска 1 << 2.
    expect(isMessageMentioningUser(message({ flags: 1 << 2 }), me)).toBe(true)
    // 2 как значение (бит 1, SuppressNotifications) упоминанием не является.
    expect(isMessageMentioningUser(message({ flags: 2 }), me)).toBe(false)
  })

  it('treats @online as a mention only for an online user', () => {
    // MessageFlags::MentionsOnline = 3 → маска 1 << 3.
    const flags = 1 << 3

    expect(
      isMessageMentioningUser(message({ flags }), me, {
        currentUser: user({ online: true }),
      }),
    ).toBe(true)
    expect(
      isMessageMentioningUser(message({ flags }), me, {
        currentUser: user({ online: false }),
      }),
    ).toBe(false)
    expect(isMessageMentioningUser(message({ flags }), me)).toBe(false)
  })

  it('ignores a role the member does not have', () => {
    expect(
      isMessageMentioningUser(
        message({ role_mentions: ['role-1'] }),
        me,
        {
          member: {
            _id: { server: 's', user: me },
            joined_at: '2024-01-01T00:00:00Z',
            roles: ['role-2'],
          },
        },
      ),
    ).toBe(false)
  })

  it('ignores a message without any mentions', () => {
    expect(isMessageMentioningUser(message(), me)).toBe(false)
    expect(isMessageMentioningUser(message(), undefined)).toBe(false)
  })
})
