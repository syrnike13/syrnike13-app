import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSyrnikeDesktop, getPlatformCapabilities } = vi.hoisted(() => ({
  getSyrnikeDesktop: vi.fn(() => null),
  getPlatformCapabilities: vi.fn(() => ({
    nativeMediaEngine: false,
  })),
}))

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop,
  getPlatformCapabilities,
}))

import {
  shouldUseDesktopMediaEngine,
  shouldUseMediaEngineScreenShare,
} from './native-screen-share-mode'

describe('shouldUseDesktopMediaEngine', () => {
  beforeEach(() => {
    getSyrnikeDesktop.mockReturnValue(null)
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: false })
  })

  it('returns false on web', () => {
    expect(shouldUseDesktopMediaEngine()).toBe(false)
  })

  it('returns true on windows desktop', () => {
    getSyrnikeDesktop.mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: true })

    expect(shouldUseDesktopMediaEngine()).toBe(true)
    expect(shouldUseMediaEngineScreenShare()).toBe(true)
  })
})
