// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isMobileAllowedPath,
  isMobileUserAgent,
  isMobileViewport,
  mapAppPathToMobile,
  mapMobilePathToApp,
  shouldUseMobileLayout,
} from '#/lib/device-routing'

describe('device-routing', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('isMobileAllowedPath', () => {
    it('matches /m and /m/*', () => {
      expect(isMobileAllowedPath('/m')).toBe(true)
      expect(isMobileAllowedPath('/m/')).toBe(true)
      expect(isMobileAllowedPath('/m/c/abc')).toBe(true)
      expect(isMobileAllowedPath('/m/profile')).toBe(true)
      expect(isMobileAllowedPath('/m/servers/x/settings?tab=general')).toBe(true)
    })

    it('rejects non-mobile paths', () => {
      expect(isMobileAllowedPath('/app')).toBe(false)
      expect(isMobileAllowedPath('/app/c/abc')).toBe(false)
      expect(isMobileAllowedPath('/login')).toBe(false)
      expect(isMobileAllowedPath('/mobile-thing')).toBe(false)
    })
  })

  describe('isMobileUserAgent', () => {
    it('returns false for desktop UA', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      )
      expect(isMobileUserAgent()).toBe(false)
    })

    it('returns true for iPhone UA', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      )
      expect(isMobileUserAgent()).toBe(true)
    })

    it('returns true for Android UA', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
      )
      expect(isMobileUserAgent()).toBe(true)
    })

    it('returns true for iPad UA', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      )
      expect(isMobileUserAgent()).toBe(true)
    })

    it('returns false for empty UA', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('')
      expect(isMobileUserAgent()).toBe(false)
    })
  })

  describe('isMobileViewport', () => {
    it('returns false when matchMedia is unavailable', () => {
      expect(isMobileViewport()).toBe(false)
    })

    it('returns matchMedia result', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 1023.98px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
      expect(isMobileViewport()).toBe(true)
    })

    it('returns false when matchMedia says wide', () => {
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
      expect(isMobileViewport()).toBe(false)
    })
  })

  describe('shouldUseMobileLayout', () => {
    it('returns true when UA is mobile, regardless of viewport', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
      )
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
      expect(shouldUseMobileLayout()).toBe(true)
    })

    it('returns true when viewport is narrow on desktop UA', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      )
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 1023.98px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
      expect(shouldUseMobileLayout()).toBe(true)
    })

    it('returns false when desktop UA and wide viewport', () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      )
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
      expect(shouldUseMobileLayout()).toBe(false)
    })
  })

  describe('mapAppPathToMobile', () => {
    it('maps /app to /m', () => {
      expect(mapAppPathToMobile('/app')).toBe('/m')
    })

    it('maps /app/c/$id to /m/c/$id', () => {
      expect(mapAppPathToMobile('/app/c/abc123')).toBe('/m/c/abc123')
    })

    it('maps nested app paths', () => {
      expect(mapAppPathToMobile('/app/servers/x/settings')).toBe(
        '/m/servers/x/settings',
      )
      expect(mapAppPathToMobile('/app/profile')).toBe('/m/profile')
    })

    it('returns null for non-app paths', () => {
      expect(mapAppPathToMobile('/login')).toBeNull()
      expect(mapAppPathToMobile('/')).toBeNull()
      expect(mapAppPathToMobile('/invite/abc')).toBeNull()
    })
  })

  describe('mapMobilePathToApp', () => {
    it('maps /m to /app', () => {
      expect(mapMobilePathToApp('/m')).toBe('/app')
    })

    it('maps /m/c/$id to /app/c/$id', () => {
      expect(mapMobilePathToApp('/m/c/abc123')).toBe('/app/c/abc123')
    })

    it('maps nested mobile paths', () => {
      expect(mapMobilePathToApp('/m/profile')).toBe('/app/profile')
      expect(mapMobilePathToApp('/m/servers/x/settings')).toBe(
        '/app/servers/x/settings',
      )
    })

    it('returns null for non-mobile paths', () => {
      expect(mapMobilePathToApp('/app')).toBeNull()
      expect(mapMobilePathToApp('/login')).toBeNull()
    })
  })
})
