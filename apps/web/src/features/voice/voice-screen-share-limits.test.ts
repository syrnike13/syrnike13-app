import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchApiRoot } = vi.hoisted(() => ({
  fetchApiRoot: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  fetchApiRoot,
}))

async function resolveFreshLimits() {
  vi.resetModules()
  const { resolveScreenShareCaptureLimits } = await import(
    './voice-screen-share-limits'
  )
  return resolveScreenShareCaptureLimits()
}

describe('resolveScreenShareCaptureLimits', () => {
  beforeEach(() => {
    fetchApiRoot.mockReset()
  })

  it('uses dedicated screen-share limits instead of camera video limits', async () => {
    fetchApiRoot.mockResolvedValue({
      features: {
        limits: {
          new_user: {
            video_resolution: [1280, 720],
            screen_share_resolution: [1920, 1080],
            screen_share_bitrate: 10_000_000,
          },
          default: {
            video_resolution: [1280, 720],
            screen_share_resolution: [1920, 1080],
            screen_share_bitrate: 10_000_000,
          },
        },
      },
    })

    await expect(resolveFreshLimits()).resolves.toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
      maxPixels: 1920 * 1080,
      maxBitrate: 10_000_000,
    })
  })

  it('falls back to the LiveKit screen-share ceiling when API limits are unavailable', async () => {
    fetchApiRoot.mockRejectedValue(new Error('offline'))

    await expect(resolveFreshLimits()).resolves.toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
      maxPixels: 1920 * 1080,
      maxBitrate: 10_000_000,
    })
  })

  it('preserves bitrate limits when resolution limits are absent', async () => {
    fetchApiRoot.mockResolvedValue({
      features: {
        limits: {
          new_user: {
            screen_share_bitrate: 3_000_000,
          },
          default: {
            screen_share_bitrate: 5_000_000,
          },
        },
      },
    })

    await expect(resolveFreshLimits()).resolves.toEqual({
      maxWidth: undefined,
      maxHeight: undefined,
      maxPixels: undefined,
      maxBitrate: 3_000_000,
    })
  })
})
