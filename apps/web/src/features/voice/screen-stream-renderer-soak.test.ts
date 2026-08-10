import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeVideoRegistry } from './native-video-registry'

class CountedVideoFrame {
  static closed = 0
  readonly displayWidth = 640
  readonly displayHeight = 360
  readonly codedWidth = 640
  readonly codedHeight = 360
  private isClosed = false

  close() {
    if (this.isClosed) throw new Error('frame closed twice')
    this.isClosed = true
    CountedVideoFrame.closed += 1
  }
}

describe('native screen renderer soak', () => {
  beforeEach(() => {
    CountedVideoFrame.closed = 0
    vi.stubGlobal('window', createRuntimeWindow())
    vi.stubGlobal('document', { visibilityState: 'visible' })
    vi.stubGlobal('VideoFrame', CountedVideoFrame)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retains at most the newest frame across a 100k-frame producer burst', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, frameMessage(1, new CountedVideoFrame()))
    const drawImage = vi.fn()
    registry.getTrack('remote-screen')!.attachCanvas({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    } as unknown as HTMLCanvasElement)
    CountedVideoFrame.closed = 0

    const frameCount = 100_000
    for (let sequence = 2; sequence < frameCount + 2; sequence += 1) {
      deliver(registry, frameMessage(sequence, new CountedVideoFrame()))
    }

    expect(CountedVideoFrame.closed).toBe(frameCount - 1)
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce()
    expect(drawImage).not.toHaveBeenCalled()

    ;(window as unknown as ReturnType<typeof createRuntimeWindow>)
      .flushAnimationFrames()

    expect(CountedVideoFrame.closed).toBe(frameCount)
    expect(drawImage).toHaveBeenCalledOnce()
  })
})

function frameMessage(sequence: number, frame: CountedVideoFrame) {
  return {
    type: 'syrnike-native-video-frame',
    metadata: {
      sessionId: 'voice',
      generation: 3,
      trackId: 'remote-screen',
      participantIdentity: 'remote',
      source: 'screen',
      local: false,
      sequence,
      rendererEpoch: 0,
    },
    frame,
  }
}

function deliver(registry: NativeVideoRegistry, data: unknown) {
  ;(
    registry as unknown as {
      onMessage(event: MessageEvent<unknown>): void
    }
  ).onMessage({
    source: window,
    origin: window.location.origin,
    data,
  } as MessageEvent<unknown>)
}

function createRuntimeWindow() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    location: { origin: 'https://app.test' },
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
