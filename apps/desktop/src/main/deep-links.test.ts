import { describe, expect, it } from 'vitest'

import { routeFromDeepLink } from './deep-links'

describe('routeFromDeepLink', () => {
  it('maps app protocol invite links to the web invite route', () => {
    expect(routeFromDeepLink('syrnike13://invite/abc-123')).toBe(
      '/invite/abc-123',
    )
  })

  it('maps public invite urls to the web invite route', () => {
    expect(routeFromDeepLink('https://syrnike13.ru/invite/abc-123')).toBe(
      '/invite/abc-123',
    )
  })

  it('rejects unsupported urls', () => {
    expect(routeFromDeepLink('https://example.com/invite/abc-123')).toBeNull()
  })
})
