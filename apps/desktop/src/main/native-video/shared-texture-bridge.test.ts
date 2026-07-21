import { describe, expect, it, vi } from 'vitest'

import {
  NativeSharedTextureBridge,
  type NativeSharedVideoFrame,
  type SharedTextureBridgeDependencies,
} from './shared-texture-bridge'

type ImportTextureOptions = Parameters<
  NonNullable<SharedTextureBridgeDependencies['importTexture']>
>[0]

function frame(sequence: number, trackId = 'camera'): NativeSharedVideoFrame {
  return { sessionId: 's', generation: 2, trackId, participantIdentity: 'p', source: trackId === 'screen' ? 'screen' : 'camera', local: false, sequence, width: 640, height: 360, timestampUs: sequence * 1_000, runtimeEpoch: 0, ntHandle: Buffer.alloc(8) }
}

function harness(maxInFlight = 3, onTrackStalled = vi.fn()) {
  const callbacks: Array<() => void> = []
  const release = vi.fn()
  const imported = vi.fn(() => ({
    textureId: String(callbacks.length),
    release: vi.fn(),
    getVideoFrame: vi.fn(),
    subtle: {} as Electron.SharedTextureImportedSubtle,
  }))
  const sendTexture = vi.fn(async () => undefined)
  const importTexture = vi.fn((options: ImportTextureOptions) => {
    callbacks.push(options.allReferencesReleased!)
    return imported() as never
  })
  const bridge = new NativeSharedTextureBridge({
    getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {} } }) as never,
    release,
    maxInFlight,
    stallTimeoutMs: 1_000,
    onTrackStalled,
    importTexture,
    sendTexture,
  })
  return {
    bridge,
    callbacks,
    release,
    imported,
    importTexture,
    sendTexture,
    onTrackStalled,
  }
}

describe('NativeSharedTextureBridge', () => {
  it('drops stale sequences without importing them', async () => {
    const h = harness()
    await h.bridge.deliver(frame(4))
    expect(await h.bridge.deliver(frame(3))).toBe(false)
    expect(h.imported).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(frame(3))
  })

  it('accepts a reset sequence after the native runtime restarts', async () => {
    const h = harness()
    await h.bridge.deliver(frame(12))
    const restarted = { ...frame(1), runtimeEpoch: 1 }

    expect(await h.bridge.deliver(restarted)).toBe(true)
    expect(h.imported).toHaveBeenCalledTimes(2)
    expect(h.sendTexture.mock.calls[0]?.[1]).toMatchObject({ rendererEpoch: 0 })
    expect(h.sendTexture.mock.calls[1]?.[1]).toMatchObject({ rendererEpoch: 1 })
  })

  it('bounds main references and waits for the Electron GPU fence', async () => {
    const h = harness(2)
    await h.bridge.deliver(frame(1))
    await h.bridge.deliver(frame(2))
    await h.bridge.deliver(frame(3))
    expect(h.release).toHaveBeenCalledTimes(1)
    h.callbacks[0]()
    expect(h.release).toHaveBeenCalledTimes(2)
  })

  it('keeps camera and screen sequencing independent', async () => {
    const h = harness()
    await h.bridge.deliver(frame(5, 'camera'))
    await h.bridge.deliver(frame(1, 'screen'))
    expect(h.imported).toHaveBeenCalledTimes(2)
  })

  it('retries a lost native release acknowledgement until it succeeds', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.release
        .mockRejectedValueOnce(new Error('runtime busy'))
        .mockRejectedValueOnce(new Error('reply lost'))
        .mockResolvedValueOnce(undefined)
      await h.bridge.deliver(frame(1))

      h.callbacks[0]()
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(200)

      expect(h.release).toHaveBeenCalledTimes(3)
      expect(h.release).toHaveBeenNthCalledWith(3, frame(1))
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds references per track so a stalled camera cannot starve a screen', async () => {
    const h = harness(1)
    await h.bridge.deliver(frame(1, 'camera'))
    await h.bridge.deliver(frame(1, 'screen'))
    expect(h.imported).toHaveBeenCalledTimes(2)
  })

  it('retires a fence-stalled epoch and requests a safe track restart', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(2)
      await h.bridge.deliver(frame(1, 'screen'))
      await h.bridge.deliver(frame(2, 'screen'))

      await vi.advanceTimersByTimeAsync(1_000)

      expect(h.onTrackStalled).toHaveBeenCalledTimes(1)
      expect(h.onTrackStalled).toHaveBeenCalledWith(frame(1, 'screen'))
      expect(await h.bridge.deliver(frame(3, 'screen'))).toBe(true)
      expect(h.release).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts a track after repeated shared-texture import failures', async () => {
    const h = harness()
    h.importTexture.mockImplementation(() => {
      throw new Error('device lost')
    })

    expect(await h.bridge.deliver(frame(1, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(3, 'screen'))).toBe(false)

    expect(h.onTrackStalled).toHaveBeenCalledTimes(1)
    expect(h.onTrackStalled).toHaveBeenCalledWith(frame(3, 'screen'))
  })

  it('does not restart a track for an isolated texture delivery failure', async () => {
    const h = harness()
    h.importTexture
      .mockImplementationOnce(() => { throw new Error('device busy') })

    expect(await h.bridge.deliver(frame(1, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(true)

    expect(h.onTrackStalled).not.toHaveBeenCalled()
  })

  it('releases references on renderer reload without bypassing the fence', async () => {
    const h = harness()
    await h.bridge.deliver(frame(1))
    h.bridge.rendererReloaded()
    expect(h.release).not.toHaveBeenCalled()
    expect(await h.bridge.deliver(frame(2))).toBe(true)
    h.callbacks[0]()
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('retires every retained frame for a lost native voice session', async () => {
    const h = harness()
    const camera = frame(1, 'camera')
    const screen = frame(1, 'screen')
    await h.bridge.deliver(camera)
    await h.bridge.deliver(screen)

    h.bridge.resetSession('s', 2)

    expect(h.release).not.toHaveBeenCalled()
    h.callbacks[0]()
    h.callbacks[1]()
    expect(h.release).toHaveBeenCalledWith(camera)
    expect(h.release).toHaveBeenCalledWith(screen)
  })

  it('does not carry delivery failures into a reloaded renderer', async () => {
    const h = harness()
    h.importTexture.mockImplementation(() => {
      throw new Error('renderer unavailable')
    })

    expect(await h.bridge.deliver(frame(1, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(false)
    h.bridge.rendererReloaded()
    expect(await h.bridge.deliver(frame(3, 'screen'))).toBe(false)

    expect(h.onTrackStalled).not.toHaveBeenCalled()
  })

  it('releases a removed local preview only after the Electron GPU fence', async () => {
    const h = harness()
    const local = { ...frame(1, 'screen'), local: true }
    await h.bridge.deliver(local)
    h.bridge.removeTrack(local.sessionId, local.generation, local.trackId)
    expect(h.release).not.toHaveBeenCalled()
    h.callbacks[0]()
    expect(h.release).toHaveBeenCalledWith(local)
  })

  it('does not restart a track that was explicitly removed', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(1)
      const removed = frame(1, 'screen')
      await h.bridge.deliver(removed)
      h.bridge.removeTrack(removed.sessionId, removed.generation, removed.trackId)

      await vi.advanceTimersByTimeAsync(1_000)

      expect(h.onTrackStalled).not.toHaveBeenCalled()
      expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
