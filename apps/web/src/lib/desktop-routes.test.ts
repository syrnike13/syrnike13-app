import { describe, expect, it } from 'vitest'

import { isDesktopAllowedPath } from './desktop-routes'

describe('isDesktopAllowedPath', () => {
  it('allows app and login routes', () => {
    expect(isDesktopAllowedPath('/app')).toBe(true)
    expect(isDesktopAllowedPath('/app/c/abc')).toBe(true)
    expect(isDesktopAllowedPath('/login')).toBe(true)
    expect(isDesktopAllowedPath('/login/register')).toBe(true)
    expect(isDesktopAllowedPath('/login/onboard')).toBe(true)
  })

  it('blocks landing and public web-only routes', () => {
    expect(isDesktopAllowedPath('/')).toBe(false)
    expect(isDesktopAllowedPath('/invite/abc')).toBe(false)
    expect(isDesktopAllowedPath('/verify/token')).toBe(false)
  })
})
