import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  defaultNativeCaptureStreamMode,
  shouldUseNativeScreenShare,
} from './native-screen-share-mode'

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

describe('shouldUseNativeScreenShare', () => {
  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
  })

  it('returns false on web', () => {
    expect(shouldUseNativeScreenShare('auto')).toBe(false)
    expect(shouldUseNativeScreenShare('native')).toBe(false)
  })

  it('returns true on windows desktop for auto and native modes', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(shouldUseNativeScreenShare('auto')).toBe(true)
    expect(shouldUseNativeScreenShare('native')).toBe(true)
    expect(shouldUseNativeScreenShare('browser')).toBe(false)
  })
})

describe('defaultNativeCaptureStreamMode', () => {
  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
  })

  it('defaults to h264 on windows desktop', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(defaultNativeCaptureStreamMode()).toBe('h264')
  })

  it('defaults to bgra on web', () => {
    expect(defaultNativeCaptureStreamMode()).toBe('bgra')
  })
})
