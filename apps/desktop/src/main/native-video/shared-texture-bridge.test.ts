import { describe, expect, it, vi } from 'vitest'

import { NativeSharedTextureBridge, type NativeSharedVideoFrame } from './shared-texture-bridge'

function frame(sequence: number, trackId = 'camera'): NativeSharedVideoFrame {
  return { sessionId: 's', generation: 2, trackId, participantIdentity: 'p', source: trackId === 'screen' ? 'screen' : 'camera', local: false, sequence, width: 640, height: 360, timestampUs: sequence * 1_000, runtimeEpoch: 0, ntHandle: Buffer.alloc(8) }
}

function harness(maxInFlight = 3) {
  const callbacks: Array<() => void> = []
  const release = vi.fn()
  const imported = vi.fn(() => ({
    textureId: String(callbacks.length),
    release: vi.fn(),
    getVideoFrame: vi.fn(),
    subtle: {} as Electron.SharedTextureImportedSubtle,
  }))
  const bridge = new NativeSharedTextureBridge({
    getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {} } }) as never,
    release,
    maxInFlight,
    importTexture: vi.fn((options) => { callbacks.push(options.allReferencesReleased!); return imported() as never }),
    sendTexture: vi.fn(async () => undefined),
  })
  return { bridge, callbacks, release, imported }
}

describe('NativeSharedTextureBridge', () => {
  it('drops stale sequences without importing them', async () => {
    const h = harness()
    await h.bridge.deliver(frame(4))
    expect(await h.bridge.deliver(frame(3))).toBe(false)
    expect(h.imported).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledWith(frame(3))
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

  it('releases references on renderer reload without bypassing the fence', async () => {
    const h = harness()
    await h.bridge.deliver(frame(1))
    h.bridge.rendererReloaded()
    expect(h.release).not.toHaveBeenCalled()
    h.callbacks[0]()
    expect(h.release).toHaveBeenCalledTimes(1)
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
})
