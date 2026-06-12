import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  ensureMediaDevicePermission,
  listMediaDevices,
} from './use-media-devices'

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

describe('media device permissions', () => {
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
        enumerateDevices: vi.fn(async () => []),
      },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    })
  })

  it('does not use browser audio capture on Windows desktop', async () => {
    const listDevices = vi.fn(async () => [])
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: { listDevices },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    await ensureMediaDevicePermission('audio')

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled()
  })

  it('keeps browser audio permission for web fallback', async () => {
    await ensureMediaDevicePermission('audio')

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true,
    })
  })

  it('lists Windows desktop audio inputs through the native media bridge', async () => {
    const nativeDevices = [
      {
        deviceId: '{0.0.1.00000000}.native-mic',
        kind: 'audioinput',
        label: 'Native microphone',
      },
    ]
    const listDevices = vi.fn(async () => nativeDevices)
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: { listDevices },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    await expect(listMediaDevices('audioinput')).resolves.toEqual(nativeDevices)

    expect(listDevices).toHaveBeenCalledWith('audioinput')
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled()
  })
})
