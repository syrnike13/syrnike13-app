import { describe, expect, it } from 'vitest'

import { getAdminRedirectUrl } from './admin/route'

describe('web admin redirect', () => {
  it('redirects production web users to production admin', () => {
    expect(getAdminRedirectUrl('syrnike13.ru')).toBe(
      'https://admin.syrnike13.ru',
    )
  })

  it('redirects nightly web users to nightly admin', () => {
    expect(getAdminRedirectUrl('beta.syrnike13.ru')).toBe(
      'https://admin.beta.syrnike13.ru',
    )
  })
})
