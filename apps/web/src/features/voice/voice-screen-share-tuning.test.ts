import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clampScreenShareCaptureResolution,
  tuneScreenShareAfterPublish,
} from './voice-screen-share-tuning'

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

describe('tuneScreenShareAfterPublish', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('applies the FullHD screen-share bitrate as both ceiling and startup floor', async () => {
    const params = { encodings: [{}] }
    const setParameters = vi.fn().mockResolvedValue(undefined)
    const sender = {
      track: { id: 'screen-track-1' },
      getParameters: () => params,
      setParameters,
    }
    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: {
              getSenders: () => [sender],
            },
          },
        },
      },
    }
    const track = {
      id: 'screen-track-1',
      getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
    } as unknown as MediaStreamTrack

    await tuneScreenShareAfterPublish(room as never, track, 'high', {
      maxWidth: 1920,
      maxHeight: 1080,
      maxPixels: 1920 * 1080,
    })

    expect(setParameters).toHaveBeenCalledWith({
      encodings: [
        expect.objectContaining({
          maxBitrate: 8_000_000,
          minBitrate: 8_000_000,
          maxFramerate: 30,
        }),
      ],
    })
  })
})
