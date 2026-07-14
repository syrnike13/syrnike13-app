import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeVideoRegistry } from './native-video-registry'

class FakeVideoFrame {
  close = vi.fn()
}

class FakeTrackGenerator {
  readonly writable = new WritableStream<VideoFrame>()
  stop = vi.fn()
}

describe('NativeVideoRegistry lifecycle fences', () => {
  beforeEach(() => {
    vi.stubGlobal('VideoFrame', FakeVideoFrame)
    vi.stubGlobal('MediaStreamTrackGenerator', FakeTrackGenerator)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores removal from an older generation of the same track', () => {
    const registry = new NativeVideoRegistry()
    const frame = new FakeVideoFrame()
    deliver(registry, {
      type: 'syrnike-native-video-frame',
      metadata: metadata(2, 1),
      frame,
    })
    expect(registry.getTrack('local-screen:session')).not.toBeNull()

    deliver(registry, {
      type: 'syrnike-native-video-track-removed',
      metadata: {
        trackId: 'local-screen:session',
        sessionId: 'session',
        generation: 1,
      },
    })
    expect(registry.getTrack('local-screen:session')).not.toBeNull()

    deliver(registry, {
      type: 'syrnike-native-video-track-removed',
      metadata: {
        trackId: 'local-screen:session',
        sessionId: 'session',
        generation: 2,
      },
    })
    expect(registry.getTrack('local-screen:session')).toBeNull()
  })

  it('closes stale sequence frames without replacing the live track', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, {
      type: 'syrnike-native-video-frame',
      metadata: metadata(2, 5),
      frame: new FakeVideoFrame(),
    })
    const track = registry.getTrack('local-screen:session')
    const stale = new FakeVideoFrame()
    deliver(registry, {
      type: 'syrnike-native-video-frame',
      metadata: metadata(2, 4),
      frame: stale,
    })
    expect(stale.close).toHaveBeenCalledOnce()
    expect(registry.getTrack('local-screen:session')).toBe(track)
  })

  it('does not resurrect a removed track from a late same-generation frame', () => {
    const registry = new NativeVideoRegistry()
    deliver(registry, {
      type: 'syrnike-native-video-track-removed',
      metadata: {
        trackId: 'local-screen:session',
        sessionId: 'session',
        generation: 2,
      },
    })
    const late = new FakeVideoFrame()
    deliver(registry, {
      type: 'syrnike-native-video-frame',
      metadata: metadata(2, 9),
      frame: late,
    })
    expect(late.close).toHaveBeenCalledOnce()
    expect(registry.getTrack('local-screen:session')).toBeNull()

    deliver(registry, {
      type: 'syrnike-native-video-frame',
      metadata: metadata(3, 1),
      frame: new FakeVideoFrame(),
    })
    expect(registry.getTrack('local-screen:session')).not.toBeNull()
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

function deliver(registry: NativeVideoRegistry, data: unknown) {
  const runtimeWindow = {
    location: { origin: 'https://app.test' },
  }
  vi.stubGlobal('window', runtimeWindow)
  ;(registry as unknown as {
    onMessage(event: MessageEvent<unknown>): void
  }).onMessage({
    source: runtimeWindow,
    origin: runtimeWindow.location.origin,
    data,
  } as unknown as MessageEvent<unknown>)
}
