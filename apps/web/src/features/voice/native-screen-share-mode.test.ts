import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  defaultNativeMediaStreamMode,
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

  it('returns true on windows desktop for every supported mode', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(shouldUseNativeScreenShare('auto')).toBe(true)
    expect(shouldUseNativeScreenShare('native')).toBe(true)
  })
})

describe('defaultNativeMediaStreamMode', () => {
  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
  })

  it('defaults to h264 on windows desktop', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(defaultNativeMediaStreamMode()).toBe('h264')
  })

  it('defaults to bgra on web', () => {
    expect(defaultNativeMediaStreamMode()).toBe('bgra')
  })
})
