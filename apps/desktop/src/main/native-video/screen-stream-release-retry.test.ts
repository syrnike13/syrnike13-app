import { describe, expect, it, vi } from 'vitest'

import {
  NativeSharedTextureBridge,
  type NativeSharedVideoFrame,
  type SharedTextureBridgeDependencies,
} from './shared-texture-bridge'

type ImportTextureOptions = Parameters<
  NonNullable<SharedTextureBridgeDependencies['importTexture']>
>[0]

const frame: NativeSharedVideoFrame = {
  sessionId: 'voice',
  generation: 3,
  trackId: 'screen',
  participantIdentity: 'remote',
  source: 'screen',
  local: false,
  sequence: 1,
  width: 640,
  height: 360,
  timestampUs: 1_000,
  runtimeEpoch: 0,
  ntHandle: Buffer.alloc(8),
}

describe('shared texture native release retry', () => {
  it('stops after the configured release attempt budget', async () => {
    vi.useFakeTimers()
    try {
      let fenceReleased!: () => void
      const release = vi.fn(async () => {
        throw new Error('runtime unavailable')
      })
      const bridge = new NativeSharedTextureBridge({
        getWindow: () => ({
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            mainFrame: {},
          },
        }) as never,
        release,
        importTexture: (options: ImportTextureOptions) => {
          fenceReleased = options.allReferencesReleased!
          return {
            textureId: 'texture',
            release: vi.fn(),
            getVideoFrame: vi.fn(),
            subtle: {} as Electron.SharedTextureImportedSubtle,
          } as never
        },
        sendTexture: vi.fn(async () => undefined),
        releaseAttempts: 4,
      })

      expect(await bridge.deliver(frame)).toBe(true)
      fenceReleased()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(release).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(release).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending release retry when the bridge is disposed', async () => {
    vi.useFakeTimers()
    try {
      let fenceReleased!: () => void
      const release = vi.fn(async () => {
        throw new Error('runtime unavailable')
      })
      const bridge = bridgeHarness(release, (releaseFence) => {
        fenceReleased = releaseFence
      })

      expect(await bridge.deliver(frame)).toBe(true)
      fenceReleased()
      await vi.advanceTimersByTimeAsync(50)
      bridge.dispose()
      await vi.advanceTimersByTimeAsync(30_000)

      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels retries owned by an older native runtime epoch', async () => {
    vi.useFakeTimers()
    try {
      let fenceReleased!: () => void
      const release = vi.fn(async () => {
        throw new Error('runtime unavailable')
      })
      const bridge = bridgeHarness(release, (releaseFence) => {
        fenceReleased = releaseFence
      })

      expect(await bridge.deliver(frame)).toBe(true)
      fenceReleased()
      await vi.advanceTimersByTimeAsync(50)
      expect(await bridge.deliver({
        ...frame,
        sequence: 1,
        runtimeEpoch: 1,
      })).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(release).toHaveBeenCalledTimes(1)
      bridge.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

function bridgeHarness(
  release: SharedTextureBridgeDependencies['release'],
  onFence: (releaseFence: () => void) => void,
) {
  return new NativeSharedTextureBridge({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: {},
      },
    }) as never,
    release,
    importTexture: (options: ImportTextureOptions) => {
      onFence(options.allReferencesReleased!)
      return {
        textureId: 'texture',
        release: vi.fn(),
        getVideoFrame: vi.fn(),
        subtle: {} as Electron.SharedTextureImportedSubtle,
      } as never
    },
    sendTexture: vi.fn(async () => undefined),
  })
}
