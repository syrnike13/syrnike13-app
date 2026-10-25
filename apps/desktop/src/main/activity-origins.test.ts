import { describe, expect, it } from 'vitest'

import { activityResponseHeaders, isActivityOriginUrl } from './activity-origins'

describe('activity origins', () => {
  it('matches production, nightly and local Activity Origins only', () => {
    expect(isActivityOriginUrl('https://chess.activities.syrnike13.ru/')).toBe(true)
    expect(
      isActivityOriginUrl('https://chess.activities.beta.syrnike13.ru/a?b'),
    ).toBe(true)
    expect(
      isActivityOriginUrl('http://chess.activities.localhost:14707/index.html'),
    ).toBe(true)
    expect(isActivityOriginUrl('https://syrnike13.ru/')).toBe(false)
    expect(isActivityOriginUrl('http://chess.activities.syrnike13.ru/')).toBe(false)
    expect(
      isActivityOriginUrl('https://chess.activities.syrnike13.ru.evil.test/'),
    ).toBe(false)
    expect(isActivityOriginUrl('not a url')).toBe(false)
  })

  it('keeps the proxy CSP and replaces embedder headers', () => {
    expect(
      activityResponseHeaders({
        'content-security-policy': ["frame-ancestors 'self'"],
        'cross-origin-embedder-policy': ['require-corp'],
      }),
    ).toEqual({
      'content-security-policy': ["frame-ancestors 'self'"],
      'Cross-Origin-Embedder-Policy': ['credentialless'],
      'Cross-Origin-Resource-Policy': ['cross-origin'],
    })
  })
})
