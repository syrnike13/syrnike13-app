// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectDesktopPlatform } from './detect-platform'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectDesktopPlatform', () => {
  it('detects Windows', () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    })
    expect(detectDesktopPlatform()).toBe('windows')
  })

  it('detects macOS', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
    })
    expect(detectDesktopPlatform()).toBe('macos')
  })

  it('detects Linux', () => {
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    })
    expect(detectDesktopPlatform()).toBe('linux')
  })

  it('returns null for unknown platforms', () => {
    vi.stubGlobal('navigator', {
      platform: 'Something',
      userAgent: 'Unknown',
    })
    expect(detectDesktopPlatform()).toBeNull()
  })
})
