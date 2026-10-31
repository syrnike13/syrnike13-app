import { describe, expect, it } from 'vitest'

import { isMobileUserAgent, mobileAppUrl } from '#/lib/device-routing'

describe('device-routing', () => {
  describe('isMobileUserAgent', () => {
    it('detects phones and tablets', () => {
      expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true)
      expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
      expect(isMobileUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true)
    })

    it('keeps desktops and empty agents on the desktop app', () => {
      expect(
        isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'),
      ).toBe(false)
      expect(isMobileUserAgent('')).toBe(false)
    })
  })

  describe('mobileAppUrl', () => {
    it('keeps the channel a phone opened', () => {
      expect(mobileAppUrl('/c/abc123')).toBe('/m/channel/abc123')
    })

    it('sends other app paths to the mobile home', () => {
      expect(mobileAppUrl('/')).toBe('/m/')
      expect(mobileAppUrl('/friends')).toBe('/m/')
      expect(mobileAppUrl('/servers/x/settings')).toBe('/m/')
    })

    it('opens invites in the mobile app', () => {
      expect(mobileAppUrl('/invite/EQN59gBc')).toBe('/m/invite/EQN59gBc')
    })

    it('leaves other public pages alone', () => {
      expect(mobileAppUrl('/login')).toBeNull()
    })
  })
})
