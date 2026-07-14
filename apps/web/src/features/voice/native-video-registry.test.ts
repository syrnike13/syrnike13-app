import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeVideoRegistry } from './native-video-registry'

let runtimeWindow: ReturnType<typeof createRuntimeWindow>

class FakeVideoFrame {
  readonly close = vi.fn()

  constructor(
    readonly displayWidth = 640,
    readonly displayHeight = 360,
    readonly codedWidth = displayWidth,
    readonly codedHeight = displayHeight,
  ) {}
}

describe('NativeVideoRegistry canvas lifecycle', () => {
  beforeEach(() => {
    runtimeWindow = createRuntimeWindow()
    vi.stubGlobal('window', runtimeWindow)
    vi.stubGlobal('VideoFrame', FakeVideoFrame)
    vi.stubGlobal(
      'MediaStreamTrackGenerator',
      class {
        constructor() {
          throw new Error('native preview must not create a track generator')
        }
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops and closes a frame when there is no mounted consumer', () => {
    const registry = new NativeVideoRegistry()
    const frame = new FakeVideoFrame()

    deliver(registry, frameMessage(1, 1, frame))

    expect(frame.close).toHaveBeenCalledOnce()
    expect(registry.listTracks()[0]).toMatchObject({ consumerCount: 0 })
  })

  it('mounts local preview demand before the first frame and releases it on detach', () => {
    const registry = new NativeVideoRegistry()
    const consumer = canvasStub()
    const detach = registry
      .getLocalScreenPreviewTrack()
      .attachCanvas(consumer.canvas)

    expect(registry.getLocalScreenPreviewConsumerCount()).toBe(1)
    const initialFrame = new FakeVideoFrame()
    deliver(registry, frameMessage(1, 1, initialFrame))
    runtimeWindow.flushAnimationFrames()
    expect(consumer.drawImage).toHaveBeenCalledWith(
      initialFrame,
      0,
      0,
      640,
      360,
    )
    expect(initialFrame.close).toHaveBeenCalledOnce()

    detach()
    expect(registry.getLocalScreenPreviewConsumerCount()).toBe(0)
  })

  it('copies a frame into every mounted canvas and closes the source immediately', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 1, new FakeVideoFrame()))
    const first = canvasStub()
    const second = canvasStub()
    const onSizeChange = vi.fn()
    const track = registry.getTrack('local-screen:session')!
    track.attachCanvas(first.canvas, onSizeChange)
    track.attachCanvas(second.canvas)
    const frame = new FakeVideoFrame(1280, 720)

    deliver(registry, frameMessage(1, 2, frame))
    runtimeWindow.flushAnimationFrames()

    expect(first.drawImage).toHaveBeenCalledWith(frame, 0, 0, 1280, 720)
    expect(second.drawImage).toHaveBeenCalledWith(frame, 0, 0, 1280, 720)
    expect(first.canvas).toMatchObject({ width: 1280, height: 720 })
    expect(onSizeChange).toHaveBeenCalledWith({ width: 1280, height: 720 })
    expect(frame.close).toHaveBeenCalledOnce()
    expect(registry.listTracks()[0]).toMatchObject({ consumerCount: 2 })
  })

  it('keeps only the latest frame while a canvas paint is pending', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 1, new FakeVideoFrame()))
    const consumer = canvasStub()
    registry.getTrack('local-screen:session')!.attachCanvas(consumer.canvas)
    const replaced = new FakeVideoFrame()
    const latest = new FakeVideoFrame()

    deliver(registry, frameMessage(1, 2, replaced))
    deliver(registry, frameMessage(1, 3, latest))

    expect(replaced.close).toHaveBeenCalledOnce()
    expect(latest.close).not.toHaveBeenCalled()
    expect(consumer.drawImage).not.toHaveBeenCalled()

    runtimeWindow.flushAnimationFrames()
    expect(consumer.drawImage).toHaveBeenCalledWith(latest, 0, 0, 640, 360)
    expect(latest.close).toHaveBeenCalledOnce()
  })

  it('stops drawing after detach and makes detach idempotent', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 1, new FakeVideoFrame()))
    const { canvas, drawImage } = canvasStub()
    const detach = registry.getTrack('local-screen:session')!.attachCanvas(canvas)
    detach()
    detach()
    const frame = new FakeVideoFrame()

    deliver(registry, frameMessage(1, 2, frame))

    expect(drawImage).not.toHaveBeenCalled()
    expect(frame.close).toHaveBeenCalledOnce()
    expect(registry.listTracks()[0]).toMatchObject({ consumerCount: 0 })
  })

  it('supports remounting the same track adapter with a new canvas', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 1, new FakeVideoFrame()))
    const track = registry.getTrack('local-screen:session')!
    const first = canvasStub()
    track.attachCanvas(first.canvas)()
    const remounted = canvasStub()
    track.attachCanvas(remounted.canvas)
    const frame = new FakeVideoFrame()

    deliver(registry, frameMessage(1, 2, frame))
    runtimeWindow.flushAnimationFrames()

    expect(first.drawImage).not.toHaveBeenCalled()
    expect(remounted.drawImage).toHaveBeenCalledOnce()
    expect(frame.close).toHaveBeenCalledOnce()
  })

  it('closes a pending frame when its track is removed before paint', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 1, new FakeVideoFrame()))
    const consumer = canvasStub()
    registry.getTrack('local-screen:session')!.attachCanvas(consumer.canvas)
    const pending = new FakeVideoFrame()
    deliver(registry, frameMessage(1, 2, pending))

    deliver(registry, removalMessage(1))
    runtimeWindow.flushAnimationFrames()

    expect(pending.close).toHaveBeenCalledOnce()
    expect(consumer.drawImage).not.toHaveBeenCalled()
    expect(runtimeWindow.cancelAnimationFrame).toHaveBeenCalledOnce()
  })

  it('replaces a generation without letting the old consumer detach the new one', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 1, new FakeVideoFrame()))
    const oldCanvas = canvasStub()
    const oldTrack = registry.getTrack('local-screen:session')!
    const detachOld = oldTrack.attachCanvas(oldCanvas.canvas)

    deliver(registry, frameMessage(2, 1, new FakeVideoFrame()))
    const currentTrack = registry.getTrack('local-screen:session')!
    const currentCanvas = canvasStub()
    currentTrack.attachCanvas(currentCanvas.canvas)
    detachOld()
    const current = new FakeVideoFrame()
    deliver(registry, frameMessage(2, 2, current))
    runtimeWindow.flushAnimationFrames()

    expect(currentTrack).not.toBe(oldTrack)
    expect(oldCanvas.drawImage).not.toHaveBeenCalled()
    expect(currentCanvas.drawImage).toHaveBeenCalledOnce()
    expect(registry.listTracks()[0]).toMatchObject({
      generation: 2,
      consumerCount: 1,
    })
    expect(current.close).toHaveBeenCalledOnce()
  })

  it('ignores removal from an older generation and fences late removed frames', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(2, 1, new FakeVideoFrame()))
    const track = registry.getTrack('local-screen:session')

    deliver(registry, removalMessage(1))
    expect(registry.getTrack('local-screen:session')).toBe(track)

    deliver(registry, removalMessage(2))
    const late = new FakeVideoFrame()
    deliver(registry, frameMessage(2, 2, late))
    expect(registry.getTrack('local-screen:session')).toBeNull()
    expect(late.close).toHaveBeenCalledOnce()
  })

  it('closes stale sequence frames without drawing them', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, 5, new FakeVideoFrame()))
    const consumer = canvasStub()
    registry.getTrack('local-screen:session')!.attachCanvas(consumer.canvas)
    const stale = new FakeVideoFrame()

    deliver(registry, frameMessage(1, 4, stale))

    expect(consumer.drawImage).not.toHaveBeenCalled()
    expect(stale.close).toHaveBeenCalledOnce()
  })
})

function metadata(generation: number, sequence: number) {
  return {
    sessionId: 'session',
    generation,
    trackId: 'local-screen:session',
    participantIdentity: 'user:native-screen',
    source: 'screen' as const,
    local: true,
    sequence,
    rendererEpoch: 0,
  }
}

function frameMessage(
  generation: number,
  sequence: number,
  frame: FakeVideoFrame,
) {
  return {
    type: 'syrnike-native-video-frame',
    metadata: metadata(generation, sequence),
    frame,
  }
}

function removalMessage(generation: number) {
  return {
    type: 'syrnike-native-video-track-removed',
    metadata: {
      trackId: 'local-screen:session',
      sessionId: 'session',
      generation,
    },
  }
}

function canvasStub() {
  const drawImage = vi.fn()
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
  } as unknown as HTMLCanvasElement
  return { canvas, drawImage }
}

function deliver(registry: NativeVideoRegistry, data: unknown) {
  ;(
    registry as unknown as {
      onMessage(event: MessageEvent<unknown>): void
    }
  ).onMessage({
    source: runtimeWindow,
    origin: runtimeWindow.location.origin,
    data,
  } as unknown as MessageEvent<unknown>)
}

function createRuntimeWindow() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    location: { origin: 'https://app.test' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextId
      callbacks.set(id, callback)
      return id
    }),
    cancelAnimationFrame: vi.fn((id: number) => callbacks.delete(id)),
    flushAnimationFrames() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(0)
    },
  }
}
