import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clampScreenShareCaptureResolution } from './voice-screen-share-tuning'

describe('clampScreenShareCaptureResolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('downscales capture tracks above the target resolution', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined)
    const track = {
      getSettings: () => ({ width: 3840, height: 2160, frameRate: 60 }),
      applyConstraints,
    } as unknown as MediaStreamTrack

    await clampScreenShareCaptureResolution(track, {
      maxWidth: 1920,
      maxHeight: 1080,
      frameRate: 60,
    })

    expect(applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
    })
  })

  it('skips resolution constraints when capture already fits', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined)
    const track = {
      getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
      applyConstraints,
    } as unknown as MediaStreamTrack

    await clampScreenShareCaptureResolution(track, {
      maxWidth: 1920,
      maxHeight: 1080,
      frameRate: 60,
    })

    expect(applyConstraints).toHaveBeenCalledWith({
      frameRate: { ideal: 60, max: 60 },
    })
  })
})
