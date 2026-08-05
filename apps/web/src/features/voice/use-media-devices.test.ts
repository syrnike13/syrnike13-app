// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  ensureMediaDevicePermission,
  listMediaDevices,
  useMediaDevices,
} from './use-media-devices'

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

describe('media device permissions', () => {
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(
          (type: string, listener: EventListenerOrEventListenerObject) => {
            if (!listeners.has(type)) {
              listeners.set(type, new Set())
            }
            listeners.get(type)!.add(listener)
          },
        ),
        removeEventListener: vi.fn(
          (type: string, listener: EventListenerOrEventListenerObject) => {
            const typeListeners = listeners.get(type)
            if (typeListeners) {
              typeListeners.delete(listener)
            }
          },
        ),
        dispatchEvent: vi.fn((event: Event) => {
          const typeListeners = listeners.get(event.type)
          if (typeListeners) {
            for (const listener of typeListeners) {
              if (typeof listener === 'function') listener(event)
              else listener.handleEvent(event)
            }
          }
          return true
        }),
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

  it('refreshes native devices from devicechange without polling', async () => {
    const setInterval = vi.spyOn(window, 'setInterval')
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([
        {
          deviceId: 'initial',
          kind: 'audioinput',
          label: 'Initial microphone',
        },
      ])
      .mockResolvedValueOnce([
        {
          deviceId: 'updated',
          kind: 'audioinput',
          label: 'Updated microphone',
        },
      ])
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: { listDevices },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const { result, unmount } = renderHook(() => useMediaDevices('audioinput'))

    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0]?.deviceId).toBe('initial')
    expect(setInterval).not.toHaveBeenCalledWith(expect.any(Function), 2_000)
    expect(listDevices).toHaveBeenCalledTimes(1)

    await act(async () => {
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current[0]?.deviceId).toBe('updated'))
    expect(listDevices).toHaveBeenCalledTimes(2)

    unmount()
    expect(navigator.mediaDevices.removeEventListener).toHaveBeenCalledWith(
      'devicechange',
      expect.any(Function),
    )
    setInterval.mockRestore()
  })
})
