import { describe, expect, it } from 'vitest'

import { isDesktopAllowedPath, isDesktopOverlayPath } from './desktop-routes'

describe('isDesktopAllowedPath', () => {
  it('allows app, invite, and login routes', () => {
    expect(isDesktopAllowedPath('/app')).toBe(true)
    expect(isDesktopAllowedPath('/app/c/abc')).toBe(true)
    expect(isDesktopAllowedPath('/desktop/overlay')).toBe(true)
    expect(isDesktopAllowedPath('/invite/abc')).toBe(true)
    expect(isDesktopAllowedPath('/login')).toBe(true)
    expect(isDesktopAllowedPath('/login/register')).toBe(true)
    expect(isDesktopAllowedPath('/login/onboard')).toBe(true)
  })

  it('blocks landing and public web-only routes', () => {
    expect(isDesktopAllowedPath('/')).toBe(false)
    expect(isDesktopAllowedPath('/verify/token')).toBe(false)
  })

  it('detects the isolated desktop overlay route', () => {
    expect(isDesktopOverlayPath('/desktop/overlay')).toBe(true)
    expect(isDesktopOverlayPath('/desktop/overlay/extra')).toBe(false)
    expect(isDesktopOverlayPath('/app')).toBe(false)
  })
})
