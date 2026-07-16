import { describe, expect, it } from 'vitest'

import { desktopReleaseMetadata } from './desktop-app-identity'
import { routeFromDeepLink, routeFromDeepLinkForMetadata } from './deep-links'

describe('routeFromDeepLink', () => {
  it('maps app protocol invite links to the web invite route', () => {
    expect(routeFromDeepLinkForMetadata(
      'syrnike13://invite/abc-123',
      desktopReleaseMetadata('stable'),
    )).toBe(
      '/invite/abc-123',
    )
  })

  it('maps public invite urls to the web invite route', () => {
    expect(routeFromDeepLinkForMetadata(
      'https://syrnike13.ru/invite/abc-123',
      desktopReleaseMetadata('stable'),
    )).toBe(
      '/invite/abc-123',
    )
  })

  it('rejects unsupported urls', () => {
    expect(routeFromDeepLink('https://example.com/invite/abc-123')).toBeNull()
  })

  it('maps nightly protocol and public urls separately', () => {
    const nightly = {
      appId: 'ru.syrnike13.desktop.nightly',
      autoUpdateEnabled: false,
      displayName: 'syrnike13 Nightly',
      protocolScheme: 'syrnike13-nightly',
      publicHost: 'beta.syrnike13.ru',
    }

    expect(
      routeFromDeepLinkForMetadata(
        'syrnike13-nightly://invite/abc-123',
        nightly,
      ),
    ).toBe('/invite/abc-123')
    expect(
      routeFromDeepLinkForMetadata(
        'https://beta.syrnike13.ru/invite/abc-123',
        nightly,
      ),
    ).toBe('/invite/abc-123')
    expect(
      routeFromDeepLinkForMetadata('syrnike13://invite/abc-123', nightly),
    ).toBeNull()
    expect(
      routeFromDeepLinkForMetadata(
        'https://syrnike13.ru/invite/abc-123',
        nightly,
      ),
    ).toBeNull()
  })
})
