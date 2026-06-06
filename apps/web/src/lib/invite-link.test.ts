import { describe, expect, it } from 'vitest'

import { inviteUrl, parseInviteCode } from './invite-link'

describe('inviteUrl', () => {
  it('uses the public app origin instead of the current browser origin', () => {
    expect(inviteUrl('abc-123_DEF')).toBe(
      'https://syrnike13.ru/invite/abc-123_DEF',
    )
  })
})

describe('parseInviteCode', () => {
  it('accepts bare invite codes and invite urls', () => {
    expect(parseInviteCode('abc-123_DEF')).toBe('abc-123_DEF')
    expect(parseInviteCode('https://syrnike13.ru/invite/abc-123')).toBe(
      'abc-123',
    )
    expect(parseInviteCode('syrnike13://invite/abc-123')).toBe('abc-123')
  })

  it('rejects decoded reserved characters from invite urls', () => {
    expect(parseInviteCode('https://syrnike13.ru/invite/%2Fabc')).toBeNull()
  })
})
