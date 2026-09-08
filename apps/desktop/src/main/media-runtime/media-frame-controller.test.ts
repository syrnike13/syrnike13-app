import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInactiveMediaPaths, type MediaEngineSnapshot, type MediaInventory, type MediaExportedFrame } from './contract'
import { MediaFrameController } from './media-frame-controller'
import type { MediaRuntimeSupervisor } from './media-runtime-supervisor'
import { TextureLeaseBridge } from './texture-lease-bridge'
import { ElectronFrameTransfers } from './electron-frame-transfers'

vi.mock('electron', () => ({ sharedTexture: {} }))

function fixture() {
  let epoch = 1
  let snapshot: MediaEngineSnapshot = {
    engineState: 'running', acceptedRevision: 1, desiredState: null,
    roomState: 'off', tracks: createInactiveMediaPaths(),
  }
  const inventory: MediaInventory = {
    microphoneMeter: { revision: 1, inputLevel: 0, gateThreshold: 0, gateOpen: false },
    audio: { revision: 1, status: 'ready', devices: [] },
    cameras: { revision: 1, status: 'ready', devices: [] },
    video: { revision: 1, publications: [] },
    sources: { revision: 0, complete: true, ok: true, truncated: false, entries: [] },
  }
  const runtime = {
    getHostEpoch: () => epoch,
    getSnapshot: vi.fn<MediaRuntimeSupervisor['getSnapshot']>(() => ({ status: 'ready', pid: 42, restartCount: 0 })),
    queryInventory: vi.fn<MediaRuntimeSupervisor['queryInventory']>(async () => inventory),
    queryFrames: vi.fn<MediaRuntimeSupervisor['queryFrames']>(async () => []),
  }
  const adapter = {
    rendererReady: vi.fn<(rendererId: string) => void>(), rendererGone: vi.fn(), setPreviewDemand: vi.fn(), setRemoteVideoDemand: vi.fn(),
    snapshot: () => snapshot,
  }
  const onInventory = vi.fn()
  const failure = vi.fn()
  const controller = new MediaFrameController(runtime, adapter, () => null, failure, onInventory)
  return {
    controller, runtime, adapter, inventory, onInventory, failure,
    nextRevision: () => { snapshot = { ...snapshot, acceptedRevision: 2 } },
    nextEpoch: () => { epoch += 1 },
    enablePreview: () => { snapshot = { ...snapshot, tracks: {
      ...snapshot.tracks, screen_preview: { revision: 1, state: 'running', warning: false },
    } } },
  }
}

describe('product media frame controller', () => {
  afterEach(() => vi.useRealTimers())

  it('bounds retained textures globally until native release completes', () => {
    const gpuCallbacks: Array<() => void> = []
    const transfers = new ElectronFrameTransfers(() => ({
      startTransferSharedTexture: () => { throw new Error('unused transfer') },
      release: callback => { if (callback) gpuCallbacks.push(callback) },
    }))
    const info = { pixelFormat: 'bgra', codedSize: { width: 16, height: 16 }, handle: { ntHandle: Buffer.alloc(8) } }
    const textures = Array.from({ length: 68 }, () => transfers.importTexture(info, () => {}))
    for (const texture of textures) texture.release()
    expect(() => transfers.importTexture(info, () => {})).toThrow('capacity')
    expect(transfers.outstanding).toBe(68)
    for (const callback of gpuCallbacks) callback()
    expect(transfers.outstanding).toBe(0)
  })

  it('retains a timed-out transfer until the original renderer proves GPU release', async () => {
    vi.useFakeTimers()
    let gpuReleased: () => void = () => {}
    const native = {
      startTransferSharedTexture: () => ({
        transfer: 'opaque', syncToken: 'opaque', pixelFormat: 'bgra',
        codedSize: { width: 16, height: 16 }, visibleRect: { x: 0, y: 0, width: 16, height: 16 }, timestamp: 1,
      }),
      release: vi.fn((callback?: () => void) => { gpuReleased = callback ?? (() => {}) }),
    }
    const transfers = new ElectronFrameTransfers(() => native)
    const sourceReleased = vi.fn()
    const texture = transfers.importTexture({
      pixelFormat: 'bgra', codedSize: { width: 16, height: 16 }, handle: { ntHandle: Buffer.alloc(8) },
    }, sourceReleased)
    const frame = { processId: 10, routingId: 20, isDestroyed: () => false, send: vi.fn() }
    const result = expect(transfers.send(texture, frame, {})).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    texture.release()
    expect(native.release).not.toHaveBeenCalled()
    expect(transfers.outstanding).toBe(1)
    transfers.acknowledge({ ...frame, processId: 11 }, texture.id, 'released')
    expect(native.release).not.toHaveBeenCalled()
    transfers.acknowledge(frame, texture.id, 'imported')
    transfers.acknowledge(frame, texture.id, 'released')
    expect(native.release).toHaveBeenCalledOnce()
    expect(sourceReleased).not.toHaveBeenCalled()
    gpuReleased()
    expect(sourceReleased).toHaveBeenCalledOnce()
    expect(transfers.outstanding).toBe(0)
    transfers.acknowledge(frame, texture.id, 'released')
    texture.release()
    expect(native.release).toHaveBeenCalledOnce()
  })

  it('drains imported frames after renderer destruction without accepting a new frame acknowledgement', async () => {
    const released = vi.fn()
    let destroyed = false
    const transfers = new ElectronFrameTransfers(() => ({
      startTransferSharedTexture: () => ({
        transfer: 'opaque', syncToken: 'opaque', pixelFormat: 'bgra',
        codedSize: { width: 16, height: 16 }, visibleRect: { x: 0, y: 0, width: 16, height: 16 }, timestamp: 1,
      }),
      release: callback => { callback?.() },
    }))
    const texture = transfers.importTexture({
      pixelFormat: 'bgra', codedSize: { width: 16, height: 16 }, handle: { ntHandle: Buffer.alloc(8) },
    }, released)
    const frame = { processId: 10, routingId: 20, isDestroyed: () => destroyed, send: vi.fn() }
    const imported = transfers.send(texture, frame, {})
    transfers.acknowledge(frame, texture.id, 'imported')
    await imported
    texture.release()
    expect(released).not.toHaveBeenCalled()
    destroyed = true
    transfers.sweep()
    expect(released).toHaveBeenCalledOnce()
    expect(transfers.outstanding).toBe(0)
  })

  it('does not query frames without preview or viewer demand', async () => {
    vi.useFakeTimers()
    const test = fixture()
    try {
      test.controller.rendererReady()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.runtime.queryFrames).not.toHaveBeenCalled()
      expect(test.runtime.queryInventory.mock.calls.length).toBeLessThanOrEqual(4)
      expect(test.onInventory).toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it.each(['receiver', 'gpu'])('detects %s release stalls 100/100 times without reusing retained textures', async phase => {
    vi.useFakeTimers()
    const gpuCallbacks: Array<() => void> = []
    const transfers = new ElectronFrameTransfers(() => ({
      startTransferSharedTexture: () => ({
        transfer: 'opaque', syncToken: 'opaque', pixelFormat: 'bgra',
        codedSize: { width: 16, height: 16 }, visibleRect: { x: 0, y: 0, width: 16, height: 16 }, timestamp: 1,
      }),
      release: callback => { if (callback) gpuCallbacks.push(callback) },
    }))
    const info = { pixelFormat: 'bgra', codedSize: { width: 16, height: 16 }, handle: { ntHandle: Buffer.alloc(8) } }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const released = vi.fn()
      const stalled = vi.fn()
      const frame = { processId: attempt + 1, routingId: 20, isDestroyed: () => false, send: vi.fn() }
      const texture = transfers.importTexture(info, released, stalled)
      const sent = transfers.send(texture, frame, {})
      transfers.acknowledge(frame, texture.id, 'imported')
      await sent
      texture.release()
      if (phase === 'gpu') transfers.acknowledge(frame, texture.id, 'released')
      await vi.advanceTimersByTimeAsync(1_999)
      transfers.sweep()
      expect(stalled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      transfers.sweep()
      expect(stalled).toHaveBeenCalledExactlyOnceWith(`${phase}_release_timeout`)
      expect(released).not.toHaveBeenCalled()
      expect(transfers.outstanding).toBe(1)

      // A different consumer still imports and returns its own texture.
      const healthyReleased = vi.fn()
      const healthy = transfers.importTexture(info, healthyReleased)
      const healthySent = transfers.send(healthy, frame, {})
      transfers.acknowledge(frame, healthy.id, 'imported')
      await healthySent
      healthy.release()
      transfers.acknowledge(frame, healthy.id, 'released')
      const healthyGpu = gpuCallbacks.pop()
      if (!healthyGpu) throw new Error('Healthy consumer did not release its reference')
      healthyGpu()
      expect(healthyReleased).toHaveBeenCalledOnce()
      expect(transfers.outstanding).toBe(1)

      await vi.advanceTimersByTimeAsync(2_000)
      transfers.sweep()
      transfers.acknowledge({ ...frame, processId: frame.processId + 1 }, texture.id, 'released')
      expect(stalled).toHaveBeenCalledOnce()
      expect(released).not.toHaveBeenCalled()
      transfers.acknowledge(frame, texture.id, 'released')
      const gpu = gpuCallbacks.pop()
      if (!gpu) throw new Error('Original consumer did not release its reference')
      gpu()
      gpu()
      transfers.acknowledge(frame, texture.id, 'released')
      texture.release()
      expect(released).toHaveBeenCalledOnce()
      expect(transfers.outstanding).toBe(0)
      expect(gpuCallbacks).toHaveLength(0)
    }
  })

  it.each(['renderer', 'revision', 'epoch'])('drops an inventory reply after %s replacement', async reason => {
    vi.useFakeTimers()
    const test = fixture()
    let resolveInventory: (value: MediaInventory) => void = () => {}
    test.runtime.queryInventory.mockImplementationOnce(() => new Promise(resolve => { resolveInventory = resolve }))
    try {
      test.controller.rendererReady()
      await vi.advanceTimersByTimeAsync(16)
      expect(test.runtime.queryInventory).toHaveBeenCalledOnce()
      if (reason === 'renderer') test.controller.rendererGone()
      if (reason === 'revision') test.nextRevision()
      if (reason === 'epoch') test.nextEpoch()
      resolveInventory(test.inventory)
      await vi.advanceTimersByTimeAsync(0)
      expect(test.onInventory).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('keeps one query in flight and releases late frames after the renderer disappears', async () => {
    vi.useFakeTimers()
    const test = fixture()
    let resolveFrames: (value: Awaited<ReturnType<MediaRuntimeSupervisor['queryFrames']>>) => void = () => {}
    test.runtime.queryFrames.mockImplementationOnce(() => new Promise(resolve => { resolveFrames = resolve }))
    try {
      test.controller.rendererReady()
      test.enablePreview()
      await vi.advanceTimersByTimeAsync(100)
      expect(test.runtime.queryFrames).toHaveBeenCalledOnce()
      test.controller.rendererGone()
      resolveFrames([{
        generation: 1, sequence: 1, slot: 0, kind: 'screen_preview', revision: 1,
        rendererId: 'old-renderer', publicationId: 'preview', participantIdentity: 'local',
        width: 960, height: 540, timestamp: 1, ingressUs: 1, handle: 123,
      }])
      await vi.advanceTimersByTimeAsync(16)
      expect(test.runtime.queryFrames).toHaveBeenLastCalledWith([{ generation: 1, sequence: 1, slot: 0 }])
      expect(test.failure).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      expect(test.runtime.queryFrames).toHaveBeenCalledTimes(2)
    } finally { test.controller.dispose() }
  })

  it('retires acknowledged texture references without waiting for a dead producer', async () => {
    type Lease = { generation: number; sequence: number; slot: number; handle: number }
    let producerGone = false
    let releaseReferences = () => {}
    const pending: Lease[] = []
    const bridge: TextureLeaseBridge<Lease, { release(): void }> = new TextureLeaseBridge({
      hostEpoch: 1,
      importTexture: (_lease, released) => {
        releaseReferences = released
        return { release: () => {} }
      },
      sendTexture: async () => {},
      returnLease: lease => {
        if (producerGone) bridge.acknowledgeRelease(lease)
        else pending.push({ ...lease, handle: 1 })
      },
      failure: () => { throw new Error('unexpected bridge failure') },
    }, value => {
      if (typeof value !== 'object' || value === null) return undefined
      if (!('generation' in value) || !('sequence' in value) || !('slot' in value) || !('handle' in value)) return undefined
      const { generation, sequence, slot, handle } = value
      if (typeof generation !== 'number' || typeof sequence !== 'number' || typeof slot !== 'number' || typeof handle !== 'number') return undefined
      return { generation, sequence, slot, handle }
    }, 2)
    bridge.setReady(true)
    await bridge.offer({ generation: 1, sequence: 1, slot: 0, handle: 1 })
    releaseReferences()
    expect(pending).toHaveLength(1)
    expect(bridge.outstanding).toBe(1)
    producerGone = true
    bridge.setReady(false)
    bridge.retryReleases()
    expect(bridge.outstanding).toBe(0)
  })

  it('projects a presentation failure independently and clears it on proven transfer recovery', () => {
    vi.useFakeTimers()
    const test = fixture()
    try {
      test.controller.rendererReady()
      test.enablePreview()
      const rendererId = test.adapter.rendererReady.mock.lastCall?.[0]
      if (!rendererId) throw new Error('Renderer was not registered')
      const frame: MediaExportedFrame = {
        generation: 1, sequence: 1, slot: 0, kind: 'screen_preview', revision: 1,
        rendererId, publicationId: 'preview', participantIdentity: 'local',
        width: 960, height: 540, timestamp: 1, ingressUs: 1, handle: 123,
      }
      test.controller['presentationFailed'](frame, 1, 'video_handle_broker_failed')
      expect(test.controller.presentationPaths().screen_preview.state).toBe('failed')
      expect(test.controller.presentationPaths().screen.state).toBe('off')
      expect(test.adapter.snapshot().roomState).toBe('off')
      test.controller['presentationRecovered'](frame, 1)
      expect(test.controller.presentationPaths().screen_preview.state).toBe('running')
      test.nextRevision()
      test.controller['presentationFailed'](frame, 1, 'late_failure')
      expect(test.controller.presentationPaths().screen_preview.state).toBe('running')
      expect(test.failure).toHaveBeenCalledTimes(1)
    } finally { test.controller.dispose() }
  })

  it('requires every stalled lease of the affected stream to drain before clearing its failure', () => {
    vi.useFakeTimers()
    const test = fixture()
    try {
      test.controller.rendererReady()
      test.enablePreview()
      const rendererId = test.adapter.rendererReady.mock.lastCall?.[0]
      if (!rendererId) throw new Error('Renderer was not registered')
      const frame: MediaExportedFrame = {
        generation: 1, sequence: 1, slot: 0, kind: 'screen_preview', revision: 1,
        rendererId, publicationId: 'preview', participantIdentity: 'local',
        width: 960, height: 540, timestamp: 1, ingressUs: 1, handle: 123,
      }
      const second = { ...frame, sequence: 2, slot: 1 }
      test.controller['presentationFailed'](frame, 1, 'video_bridge_receiver_release_timeout', true)
      test.controller['presentationFailed'](second, 1, 'video_bridge_gpu_release_timeout', true)
      test.controller['presentationRecovered']({ ...frame, publicationId: 'other' }, 1)
      test.controller['presentationRecovered']({ ...frame, sequence: 3 }, 1)
      expect(test.controller.presentationPaths().screen_preview.state).toBe('failed')
      test.controller['presentationRecovered'](frame, 1)
      expect(test.controller.presentationPaths().screen_preview.state).toBe('failed')
      expect(test.failure).toHaveBeenCalledOnce()
      test.controller['presentationRecovered'](second, 1)
      expect(test.controller.presentationPaths().screen_preview.state).toBe('running')
      test.nextEpoch()
      test.controller['presentationFailed'](frame, 1, 'late_stall', true)
      expect(test.failure).toHaveBeenCalledOnce()
    } finally { test.controller.dispose() }
  })
})
