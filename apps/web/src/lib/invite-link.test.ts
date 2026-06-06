import { describe, expect, it } from 'vitest'

import { parseInviteCode } from './invite-link'

describe('parseInviteCode', () => {
  it('accepts bare invite codes and invite urls', () => {
    expect(parseInviteCode('abc-123_DEF')).toBe('abc-123_DEF')
    expect(parseInviteCode('https://syrnike13.ru/invite/abc-123')).toBe(
      'abc-123',
    )
  })

  it('rejects decoded reserved characters from invite urls', () => {
    expect(parseInviteCode('https://syrnike13.ru/invite/%2Fabc')).toBeNull()
  })
})
