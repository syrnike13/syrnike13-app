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

function harness(
  maxInFlight = 3,
  onPresentationStalled = vi.fn(),
  maxRetainedBytes?: number,
  retiredFenceReloadMs?: number,
  retiredFenceRecycleMs?: number,
) {
  let ownerDestroyed = false
  let ownerDetached = false
  const ownerFrame = {
    isDestroyed: () => ownerDestroyed,
    get detached() { return ownerDetached },
  } as unknown as Electron.WebFrameMain
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
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: ownerFrame },
    }) as never,
    release,
    maxInFlight,
    maxRetainedBytes,
    stallTimeoutMs: 1_000,
    retiredFenceReloadMs,
    retiredFenceRecycleMs,
    onPresentationStalled,
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
    onPresentationStalled,
    ownerFrame,
    destroyOwner: () => { ownerDestroyed = true },
    detachOwner: () => { ownerDetached = true },
  }
}

describe('NativeSharedTextureBridge', () => {
  it('keeps a never-settling send owned while its exact renderer frame is alive', async () => {
    const h = harness()
    h.sendTexture.mockImplementationOnce(() => new Promise<void>(() => {}))

    let deliverySettled = false
    void h.bridge.deliver(frame(1)).then(() => { deliverySettled = true })
    await vi.waitFor(() => expect(h.imported).toHaveBeenCalledTimes(1))
    h.bridge.rendererReloaded()
    await Promise.resolve()

    expect(deliverySettled).toBe(false)
    expect(h.imported.mock.results[0]!.value.release).not.toHaveBeenCalled()
    expect(h.bridge.inFlightCount).toBe(1)
    expect(h.bridge.retainedByteCount).toBe(640 * 360 * 4)
  })

  it.each(['detached', 'destroyed'] as const)(
    'settles an unresolved delivery only after its exact renderer owner is %s',
    async (termination) => {
      const h = harness()
      h.sendTexture.mockImplementationOnce(() => new Promise<void>(() => {}))
      const delivery = h.bridge.deliver(frame(1))
      await vi.waitFor(() => expect(h.imported).toHaveBeenCalledTimes(1))
      const imported = h.imported.mock.results[0]!.value

      h.bridge.rendererReloaded()
      expect(imported.release).not.toHaveBeenCalled()
      if (termination === 'detached') h.detachOwner()
      else h.destroyOwner()
      if (termination === 'detached') h.bridge.rendererReloaded()
      else h.bridge.rendererOwnerTerminated()

      expect(await delivery).toBe(false)
      expect(imported.release).toHaveBeenCalledTimes(1)
      h.callbacks[0]!()
      expect(h.release).toHaveBeenCalledTimes(1)
      expect(h.bridge.inFlightCount).toBe(0)
      expect(h.bridge.retainedByteCount).toBe(0)
    },
  )

  it('keeps a replaced-runtime unresolved send in bounded retired-fence recovery', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(3, vi.fn(), undefined, 10, 20)
      h.sendTexture.mockImplementationOnce(() => new Promise<void>(() => {}))
      const delivery = h.bridge.deliver(frame(1))
      await vi.waitFor(() => expect(h.imported).toHaveBeenCalledTimes(1))

      h.bridge.runtimeReplaced(1)
      await vi.advanceTimersByTimeAsync(21)

      expect(h.onPresentationStalled).toHaveBeenCalledWith(
        frame(1),
        'retired-fence-recycle',
        expect.any(Object),
      )
      expect(h.bridge.inFlightCount).toBe(1)
      expect(h.imported.mock.results[0]!.value.release).not.toHaveBeenCalled()

      h.detachOwner()
      await vi.advanceTimersByTimeAsync(21)
      expect(await delivery).toBe(false)
      expect(h.imported.mock.results[0]!.value.release).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-release when the raw send promise settles after owner termination', async () => {
    let settleRawSend: (() => void) | undefined
    const rawSend = new Promise<void>((resolve) => { settleRawSend = resolve })
    const h = harness()
    h.sendTexture.mockImplementationOnce(() => rawSend)
    const delivery = h.bridge.deliver(frame(1))
    await vi.waitFor(() => expect(h.imported).toHaveBeenCalledTimes(1))
    const imported = h.imported.mock.results[0]!.value

    h.detachOwner()
    h.bridge.rendererOwnerTerminated()
    expect(await delivery).toBe(false)
    expect(imported.release).toHaveBeenCalledTimes(1)
    h.callbacks[0]!()
    settleRawSend?.()
    await Promise.resolve()

    expect(imported.release).toHaveBeenCalledTimes(1)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.bridge.inFlightCount).toBe(0)
  })

  it.each([
    {
      label: 'renderer reload',
      retire: (bridge: NativeSharedTextureBridge) => bridge.rendererReloaded(),
      expectedNativeReleases: 1,
    },
    {
      label: 'runtime replacement',
      retire: (bridge: NativeSharedTextureBridge) => bridge.runtimeReplaced(1),
      expectedNativeReleases: 0,
    },
  ])('defers main-reference release until an unresolved send settles on $label', async ({ retire, expectedNativeReleases }) => {
    let settleSend: (() => void) | undefined
    const sendPending = new Promise<void>((resolve) => { settleSend = resolve })
    const h = harness()
    h.sendTexture.mockImplementationOnce(() => sendPending)

    const delivery = h.bridge.deliver(frame(1))
    await vi.waitFor(() => expect(h.imported).toHaveBeenCalledTimes(1))
    const imported = h.imported.mock.results[0]!.value

    retire(h.bridge)
    const releasedBeforeSendSettled = imported.release.mock.calls.length
    const inFlightBeforeSendSettled = h.bridge.inFlightCount

    settleSend?.()
    expect(await delivery).toBe(true)
    expect(releasedBeforeSendSettled).toBe(0)
    expect(inFlightBeforeSendSettled).toBe(1)
    expect(imported.release).toHaveBeenCalledTimes(1)
    h.callbacks[0]!()
    expect(h.release).toHaveBeenCalledTimes(expectedNativeReleases)
    expect(h.bridge.inFlightCount).toBe(0)
    expect(h.bridge.retainedByteCount).toBe(0)
  })

  it('performs a deferred release exactly once when an unresolved send rejects', async () => {
    let rejectSend: ((error: Error) => void) | undefined
    const sendPending = new Promise<void>((_resolve, reject) => {
      rejectSend = reject
    })
    const h = harness()
    h.sendTexture.mockImplementationOnce(() => sendPending)

    const delivery = h.bridge.deliver(frame(1))
    await vi.waitFor(() => expect(h.imported).toHaveBeenCalledTimes(1))
    const imported = h.imported.mock.results[0]!.value

    h.bridge.rendererReloaded()
    const releasedBeforeSendSettled = imported.release.mock.calls.length
    rejectSend?.(new Error('renderer retired during send'))
    expect(await delivery).toBe(false)
    expect(releasedBeforeSendSettled).toBe(0)
    expect(imported.release).toHaveBeenCalledTimes(1)
    h.callbacks[0]!()
    h.callbacks[0]!()
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.bridge.inFlightCount).toBe(0)
    expect(h.bridge.retainedByteCount).toBe(0)
  })

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

  it('bounds unfenced references and waits for the Electron GPU fence', async () => {
    const h = harness(2)
    await h.bridge.deliver(frame(1))
    await h.bridge.deliver(frame(2))
    await h.bridge.deliver(frame(3))
    expect(h.release).toHaveBeenCalledTimes(1)
    h.callbacks[0]()
    expect(h.release).toHaveBeenCalledTimes(2)
  })

  it.each([
    { label: 'remote video', source: 'camera' as const, local: false },
    { label: 'local screen preview', source: 'screen' as const, local: true },
    { label: 'local camera preview', source: 'camera' as const, local: true },
  ])('keeps $label allocations fenced across delayed and missing releases', async ({
    label,
    source,
    local,
  }) => {
    vi.useFakeTimers()
    try {
      const h = harness(1)
      const original = {
        ...frame(1, `${label}-track`),
        source,
        local,
      }
      const replacement = { ...original, sequence: 2, timestampUs: 2_000 }
      const excess = { ...original, sequence: 3, timestampUs: 3_000 }

      expect(await h.bridge.deliver(original)).toBe(true)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(h.release).not.toHaveBeenCalledWith(original)

      expect(await h.bridge.deliver(replacement)).toBe(true)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(await h.bridge.deliver(excess)).toBe(false)
      expect(h.release).toHaveBeenCalledWith(excess)
      expect(h.release).not.toHaveBeenCalledWith(original)
      expect(h.release).not.toHaveBeenCalledWith(replacement)

      h.callbacks[0]()
      h.callbacks[0]()
      expect(h.release).toHaveBeenCalledTimes(2)
      expect(h.release).toHaveBeenCalledWith(original)
      expect(h.bridge.inFlightCount).toBe(1)

      h.callbacks[1]()
      expect(h.release).toHaveBeenCalledTimes(3)
      expect(h.release).toHaveBeenCalledWith(replacement)
      expect(h.bridge.inFlightCount).toBe(0)
      expect(h.bridge.retainedByteCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an old generation fence block the replacement track', async () => {
    const h = harness(1)
    await h.bridge.deliver(frame(1, 'screen'))

    const replacement = {
      ...frame(1, 'screen'),
      generation: 3,
    }
    expect(await h.bridge.deliver(replacement)).toBe(true)
    expect(h.importTexture).toHaveBeenCalledTimes(2)
  })

  it('keeps camera and screen sequencing independent', async () => {
    const h = harness()
    await h.bridge.deliver(frame(5, 'camera'))
    await h.bridge.deliver(frame(1, 'screen'))
    expect(h.imported).toHaveBeenCalledTimes(2)
  })

  it('delegates one release obligation to the supervised voice-control lane', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.release.mockRejectedValueOnce(new Error('supervisor recycled runtime'))
      await h.bridge.deliver(frame(1))

      h.callbacks[0]()
      await vi.advanceTimersByTimeAsync(30_000)

      expect(h.release).toHaveBeenCalledTimes(1)
      expect(h.release).toHaveBeenCalledWith(frame(1))
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires every old-runtime reference exactly once before a replacement frame arrives', async () => {
    const h = harness()
    const first = frame(1, 'camera')
    const second = frame(1, 'screen')
    await h.bridge.deliver(first)
    await h.bridge.deliver(second)

    h.bridge.runtimeReplaced(1)
    h.bridge.runtimeReplaced(1)

    const firstImported = h.imported.mock.results[0]!.value
    const secondImported = h.imported.mock.results[1]!.value
    expect(firstImported.release).toHaveBeenCalledTimes(1)
    expect(secondImported.release).toHaveBeenCalledTimes(1)

    h.callbacks[0]()
    h.callbacks[1]()
    expect(h.release).not.toHaveBeenCalled()
    expect(h.bridge.inFlightCount).toBe(0)
    expect(h.bridge.retainedByteCount).toBe(0)
  })

  it('bounds references per track so a stalled camera cannot starve a screen', async () => {
    const h = harness(1)
    await h.bridge.deliver(frame(1, 'camera'))
    await h.bridge.deliver(frame(1, 'screen'))
    expect(h.imported).toHaveBeenCalledTimes(2)
  })

  it('retires a fence-stalled epoch and requests local presentation recovery', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(2)
      await h.bridge.deliver(frame(1, 'screen'))
      await h.bridge.deliver(frame(2, 'screen'))

      await vi.advanceTimersByTimeAsync(1_000)

      expect(h.onPresentationStalled).toHaveBeenCalledTimes(1)
      expect(h.onPresentationStalled).toHaveBeenCalledWith(
        frame(1, 'screen'),
        'shared-texture-fence',
        expect.objectContaining({
          retainedFrames: 2,
          trackRetainedReferences: 2,
          oldestRetainedAgeMs: 1_000,
        }),
      )
      expect(await h.bridge.deliver(frame(3, 'screen'))).toBe(true)
      expect(await h.bridge.deliver(frame(4, 'screen'))).toBe(true)
      expect(await h.bridge.deliver(frame(5, 'screen'))).toBe(false)
      expect(h.bridge.inFlightCount).toBe(4)
      expect(h.release).toHaveBeenCalledWith(frame(5, 'screen'))

      h.callbacks[0]()
      expect(h.bridge.inFlightCount).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not multiply retained textures across repeated presentation stalls', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(2)
      await h.bridge.deliver(frame(1, 'screen'))
      await h.bridge.deliver(frame(2, 'screen'))

      await vi.advanceTimersByTimeAsync(1_000)
      for (let sequence = 3; sequence <= 100; sequence += 1) {
        expect(await h.bridge.deliver(frame(sequence, 'screen')))
          .toBe(sequence <= 4)
      }

      expect(h.bridge.inFlightCount).toBe(4)
      expect(h.importTexture).toHaveBeenCalledTimes(4)
      expect(h.onPresentationStalled).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('independently reloads then recycles one retired renderer generation', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(2, vi.fn(), undefined, 2_000, 4_000)
      await h.bridge.deliver(frame(1, 'screen'))
      await h.bridge.deliver(frame(2, 'screen'))

      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.onPresentationStalled).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.onPresentationStalled).toHaveBeenLastCalledWith(
        frame(1, 'screen'),
        'retired-fence-deadline',
        expect.objectContaining({ trackRetiredReferences: 2 }),
      )
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.onPresentationStalled).toHaveBeenLastCalledWith(
        frame(1, 'screen'),
        'retired-fence-recycle',
        expect.objectContaining({ trackRetiredReferences: 2 }),
      )
      expect(h.onPresentationStalled).toHaveBeenCalledTimes(3)
      expect(h.release).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes the independent retired deadline after the authoritative fence', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(1, vi.fn(), undefined, 2_000, 4_000)
      await h.bridge.deliver(frame(1, 'screen'))
      await vi.advanceTimersByTimeAsync(1_000)
      h.callbacks[0]()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(h.onPresentationStalled).toHaveBeenCalledTimes(1)
      expect(h.release).toHaveBeenCalledTimes(1)
      expect(h.bridge.inFlightCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps old-runtime renderer fences in bounded recovery without targeting the replacement', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(1, vi.fn(), undefined, 2_000, 4_000)
      await h.bridge.deliver(frame(1, 'screen'))
      await vi.advanceTimersByTimeAsync(1_000)
      h.bridge.runtimeReplaced(1)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(h.onPresentationStalled).toHaveBeenCalledTimes(4)
      expect(h.onPresentationStalled.mock.calls.map((call) => call[1])).toEqual([
        'shared-texture-fence',
        'retired-fence-deadline',
        'retired-fence-recycle',
        'retired-fence-recycle',
      ])
      expect(h.onPresentationStalled.mock.calls.every(
        (call) => call[0].runtimeEpoch === 0,
      )).toBe(true)
      expect(h.release).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates to renderer replacement when retained fences hit the hard cap', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(1)
      await h.bridge.deliver(frame(1, 'screen'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(true)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(await h.bridge.deliver(frame(3, 'screen'))).toBe(false)

      expect(h.onPresentationStalled).toHaveBeenLastCalledWith(
        frame(3, 'screen'),
        'retained-budget-exhausted',
        expect.objectContaining({
          retainedFrames: 2,
          capacityRejectedFrames: 1,
          rejectedFrames: 1,
        }),
      )
      expect(h.bridge.inFlightCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds retained texture bytes across different tracks', async () => {
    const bytesPerFrame = frame(1).width * frame(1).height * 4
    const h = harness(3, vi.fn(), bytesPerFrame * 2)

    expect(await h.bridge.deliver(frame(1, 'camera-a'))).toBe(true)
    expect(await h.bridge.deliver(frame(1, 'camera-b'))).toBe(true)
    expect(await h.bridge.deliver(frame(1, 'camera-c'))).toBe(false)
    expect(h.bridge.retainedByteCount).toBe(bytesPerFrame * 2)

    h.callbacks[0]()
    expect(h.bridge.retainedByteCount).toBe(bytesPerFrame)
    expect(await h.bridge.deliver(frame(2, 'camera-c'))).toBe(true)
  })

  it('recovers presentation after repeated shared-texture import failures', async () => {
    const h = harness()
    h.importTexture.mockImplementation(() => {
      throw new Error('device lost')
    })

    expect(await h.bridge.deliver(frame(1, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(3, 'screen'))).toBe(false)

    expect(h.onPresentationStalled).toHaveBeenCalledTimes(1)
    expect(h.onPresentationStalled).toHaveBeenCalledWith(
      frame(3, 'screen'),
      'renderer-delivery',
      expect.objectContaining({
        operationFailures: 3,
        deliveryFailures: 3,
        rejectedFrames: 3,
      }),
    )
  })

  it('does not recover presentation for an isolated texture delivery failure', async () => {
    const h = harness()
    h.importTexture
      .mockImplementationOnce(() => { throw new Error('device busy') })

    expect(await h.bridge.deliver(frame(1, 'screen'))).toBe(false)
    expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(true)

    expect(h.onPresentationStalled).not.toHaveBeenCalled()
  })

  it('releases references on renderer reload without bypassing the fence', async () => {
    const h = harness()
    await h.bridge.deliver(frame(1))
    h.bridge.rendererReloaded()
    expect(h.release).not.toHaveBeenCalled()
    expect(await h.bridge.deliver(frame(2))).toBe(true)
    expect(await h.bridge.deliver(frame(3))).toBe(true)
    expect(await h.bridge.deliver(frame(4))).toBe(true)
    expect(await h.bridge.deliver(frame(5))).toBe(false)
    expect(h.bridge.inFlightCount).toBe(4)
    h.callbacks[0]()
    expect(h.release).toHaveBeenCalledTimes(2)
    h.callbacks[1]()
    h.callbacks[2]()
    h.callbacks[3]()
    expect(h.release).toHaveBeenCalledTimes(5)
    expect(h.bridge.inFlightCount).toBe(0)
    expect(h.bridge.retainedByteCount).toBe(0)
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

    expect(h.onPresentationStalled).not.toHaveBeenCalled()
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

  it('clears the stall timer when a track is explicitly removed', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(1)
      const removed = frame(1, 'screen')
      await h.bridge.deliver(removed)
      h.bridge.removeTrack(removed.sessionId, removed.generation, removed.trackId)

      await vi.advanceTimersByTimeAsync(1_000)

      expect(h.onPresentationStalled).not.toHaveBeenCalled()
      expect(await h.bridge.deliver(frame(2, 'screen'))).toBe(true)
      h.callbacks[0]()
    } finally {
      vi.useRealTimers()
    }
  })
})
