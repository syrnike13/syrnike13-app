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

  it('lists an unsubscribed screen publication before any frame exists', () => {
    const registry = new NativeVideoRegistry()

    deliver(registry, publicationMessage('available'))

    expect(registry.listTracks()).toEqual([])
    expect(registry.listPublications()).toEqual([
      expect.objectContaining({
        trackId: 'remote-screen',
        demandTrackId: 'remote-screen',
        participantIdentity: 'remote-user',
        source: 'screen',
        track: null,
      }),
    ])
  })

  it('removes materialized video without removing publication availability', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(1, new FakeVideoFrame()))

    deliver(registry, remoteRemovalMessage())

    expect(registry.getTrack('remote-screen')).toBeNull()
    expect(registry.listPublications()[0]).toMatchObject({
      demandTrackId: 'remote-screen',
      track: null,
    })
  })

  it('accepts re-demand frames only after the stable publication is re-announced', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(1, new FakeVideoFrame()))
    deliver(registry, remoteRemovalMessage())
    const late = new FakeVideoFrame()
    deliver(registry, remoteFrameMessage(2, late))
    expect(late.close).toHaveBeenCalledOnce()
    expect(registry.getTrack('remote-screen')).toBeNull()

    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(1, new FakeVideoFrame()))

    expect(registry.getTrack('remote-screen')).toBe(
      registry.listPublications()[0]?.track,
    )
  })

  it('removes publication availability on unpublish and fences late frames', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, publicationMessage('available'))
    deliver(registry, publicationMessage('unavailable'))
    const late = new FakeVideoFrame()

    deliver(registry, remoteFrameMessage(1, late))

    expect(registry.listPublications()).toEqual([])
    expect(registry.getTrack('remote-screen')).toBeNull()
    expect(late.close).toHaveBeenCalledOnce()
  })

  it('does not attach a stale same-generation track from another session', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(1, new FakeVideoFrame()))
    const nextSession = publicationMessage('available')
    nextSession.metadata.sessionId = 'next-session'

    deliver(registry, nextSession)

    expect(registry.listPublications()[0]).toMatchObject({
      sessionId: 'next-session',
      track: null,
    })
  })

  it('ignores a removed event from the previous session', () => {
    const registry = new NativeVideoRegistry()
    const publication = publicationMessage('available')
    publication.metadata.sessionId = 'next-session'
    deliver(registry, publication)
    const currentFrame = remoteFrameMessage(1, new FakeVideoFrame())
    currentFrame.metadata.sessionId = 'next-session'
    deliver(registry, currentFrame)

    deliver(registry, remoteRemovalMessage())

    expect(registry.getTrack('remote-screen')).toBe(
      registry.listPublications()[0]?.track,
    )
  })

  it('clears remote media between voice channels and rejects late old-session events', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(1, new FakeVideoFrame()))

    registry.clearRemote()

    expect(registry.listPublications()).toEqual([])
    expect(registry.listTracks()).toEqual([])
    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(2, new FakeVideoFrame()))
    expect(registry.listPublications()).toEqual([])
    expect(registry.listTracks()).toEqual([])
  })

  it('purges the previous session when a newer generation starts', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, publicationMessage('available'))
    deliver(registry, remoteFrameMessage(1, new FakeVideoFrame()))
    const nextPublication = publicationMessage('available')
    nextPublication.metadata = {
      ...nextPublication.metadata,
      trackId: 'next-screen',
      sessionId: 'next-session',
      generation: 2,
    }

    deliver(registry, nextPublication)

    expect(registry.getTrack('remote-screen')).toBeNull()
    expect(registry.listPublications()).toEqual([
      expect.objectContaining({
        trackId: 'next-screen',
        sessionId: 'next-session',
        generation: 2,
      }),
    ])
    deliver(registry, publicationMessage('available'))
    expect(registry.listPublications()).toHaveLength(1)
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

function publicationMessage(state: 'available' | 'unavailable') {
  return {
    type: `syrnike-native-screen-publication-${state}`,
    metadata: {
      trackId: 'remote-screen',
      participantIdentity: 'remote-user',
      source: 'screen',
      sessionId: 'session',
      generation: 1,
    },
  }
}

function remoteFrameMessage(sequence: number, frame: FakeVideoFrame) {
  return {
    type: 'syrnike-native-video-frame',
    metadata: {
      sessionId: 'session',
      generation: 1,
      trackId: 'remote-screen',
      participantIdentity: 'remote-user',
      source: 'screen',
      local: false,
      sequence,
      rendererEpoch: 0,
    },
    frame,
  }
}

function remoteRemovalMessage() {
  return {
    type: 'syrnike-native-video-track-removed',
    metadata: {
      trackId: 'remote-screen',
      sessionId: 'session',
      generation: 1,
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
