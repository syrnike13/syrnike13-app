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
  defaultNativeCaptureStreamMode,
  shouldUseMediaEngineScreenShare,
  shouldUseNativeScreenShare,
} from './native-screen-share-mode'

describe('shouldUseMediaEngineScreenShare', () => {
  beforeEach(() => {
    getSyrnikeDesktop.mockReturnValue(null)
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: false })
    vi.stubEnv('VITE_NATIVE_MEDIA_ENGINE', '')
  })

  it('returns false without feature flag', () => {
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: true })
    expect(shouldUseMediaEngineScreenShare()).toBe(false)
  })

  it('returns true on windows desktop with feature flag', () => {
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: true })
    vi.stubEnv('VITE_NATIVE_MEDIA_ENGINE', 'true')
    expect(shouldUseMediaEngineScreenShare()).toBe(true)
  })
})

describe('shouldUseNativeScreenShare', () => {
  beforeEach(() => {
    getSyrnikeDesktop.mockReturnValue(null)
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: false })
    vi.stubEnv('VITE_NATIVE_MEDIA_ENGINE', '')
  })

  it('returns false on web', () => {
    expect(shouldUseNativeScreenShare('auto')).toBe(false)
    expect(shouldUseNativeScreenShare('native')).toBe(false)
  })

  it('returns true on windows desktop for auto and native modes', () => {
    getSyrnikeDesktop.mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(shouldUseNativeScreenShare('auto')).toBe(true)
    expect(shouldUseNativeScreenShare('native')).toBe(true)
    expect(shouldUseNativeScreenShare('browser')).toBe(false)
  })

  it('prefers media engine path when feature flag is enabled', () => {
    getPlatformCapabilities.mockReturnValue({ nativeMediaEngine: true })
    vi.stubEnv('VITE_NATIVE_MEDIA_ENGINE', 'true')

    expect(shouldUseNativeScreenShare('browser')).toBe(true)
  })
})

describe('defaultNativeCaptureStreamMode', () => {
  beforeEach(() => {
    getSyrnikeDesktop.mockReturnValue(null)
    vi.stubEnv('VITE_NATIVE_CAPTURE_BGRA', '')
  })

  it('defaults to h264 on windows desktop', () => {
    getSyrnikeDesktop.mockReturnValue({
      runtime: 'desktop',
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(defaultNativeCaptureStreamMode()).toBe('h264')
  })

  it('defaults to bgra on web', () => {
    expect(defaultNativeCaptureStreamMode()).toBe('bgra')
  })
})
