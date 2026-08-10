import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NativeSharedTextureBridge,
  type NativeSharedVideoFrame,
} from './shared-texture-bridge'

describe('screen stream presentation metrics', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the physical retained texture count separately from rejected frames', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const fenceCallbacks: Array<() => void> = []
    const stalled = vi.fn()
    const bridge = new NativeSharedTextureBridge({
      getWindow: () => windowStub(),
      release: vi.fn(),
      maxInFlight: 1,
      stallTimeoutMs: 1_000,
      importTexture: (options) => {
        fenceCallbacks.push(options.allReferencesReleased!)
        return importedTexture()
      },
      sendTexture: vi.fn(async () => undefined),
      onPresentationStalled: stalled,
    })

    expect(await bridge.deliver(frame(1))).toBe(true)
    expect(await bridge.deliver(frame(2))).toBe(false)
    expect(await bridge.deliver(frame(3))).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(stalled).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1 }),
      'shared-texture-fence',
      expect.objectContaining({
        retainedFrames: 1,
        trackActiveReferences: 1,
        trackRetainedReferences: 1,
        oldestRetainedAgeMs: 1_000,
        deliveredFrames: 1,
        rejectedFrames: 2,
        capacityRejectedFrames: 2,
        maximumActiveReferences: 1,
        maximumTrackReferences: 2,
      }),
    )
    expect(fenceCallbacks).toHaveLength(1)
    bridge.dispose()
  })

  it('reports a failed shared-texture operation with the same bounded snapshot', async () => {
    const failed = vi.fn()
    const bridge = new NativeSharedTextureBridge({
      getWindow: () => windowStub(),
      release: vi.fn(),
      now: () => 10_000,
      importTexture: () => {
        throw new Error('import failed')
      },
      onOperationFailed: failed,
    })

    expect(await bridge.deliver(frame(1))).toBe(false)
    expect(failed).toHaveBeenCalledWith(
      'import',
      expect.objectContaining({ sequence: 1 }),
      expect.any(Error),
      expect.objectContaining({
        deliveredFrames: 0,
        rejectedFrames: 1,
        operationFailures: 1,
      }),
    )
    bridge.dispose()
  })
})

function frame(sequence: number): NativeSharedVideoFrame {
  return {
    sessionId: 'voice',
    generation: 4,
    trackId: 'screen-track',
    participantIdentity: 'participant',
    source: 'screen',
    local: false,
    sequence,
    width: 1_920,
    height: 1_080,
    timestampUs: sequence * 1_000,
    runtimeEpoch: 0,
    ntHandle: Buffer.alloc(8),
  }
}

function windowStub() {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: {},
    },
  } as never
}

function importedTexture(): Electron.SharedTextureImported {
  return {
    textureId: 'texture',
    release: vi.fn(),
    getVideoFrame: vi.fn(),
    subtle: {} as Electron.SharedTextureImportedSubtle,
  }
}
