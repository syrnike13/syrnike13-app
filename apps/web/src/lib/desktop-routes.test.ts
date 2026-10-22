import { describe, expect, it } from 'vitest'

import { isDesktopAllowedPath, isDesktopOverlayPath } from './desktop-routes'

describe('isDesktopAllowedPath', () => {
  it('allows the app, invite, and login routes', () => {
    expect(isDesktopAllowedPath('/')).toBe(true)
    expect(isDesktopAllowedPath('/c/abc')).toBe(true)
    expect(isDesktopAllowedPath('/desktop/overlay')).toBe(true)
    expect(isDesktopAllowedPath('/invite/abc')).toBe(true)
    expect(isDesktopAllowedPath('/login')).toBe(true)
    expect(isDesktopAllowedPath('/login/register')).toBe(true)
    expect(isDesktopAllowedPath('/login/onboard')).toBe(true)
  })

  it('blocks public web-only routes', () => {
    expect(isDesktopAllowedPath('/verify/token')).toBe(false)
    expect(isDesktopAllowedPath('/dev/ui')).toBe(false)
  })

  it('detects the isolated desktop overlay route', () => {
    expect(isDesktopOverlayPath('/desktop/overlay')).toBe(true)
    expect(isDesktopOverlayPath('/desktop/overlay/extra')).toBe(false)
    expect(isDesktopOverlayPath('/')).toBe(false)
  })
})
