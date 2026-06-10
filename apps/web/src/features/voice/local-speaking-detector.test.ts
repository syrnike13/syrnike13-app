// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createLocalSpeakingDetector,
  type LocalSpeakingDetector,
} from '#/features/voice/local-speaking-detector'

function installMediaStreamMock() {
  let trackId = 0

  class TestMediaStreamTrack {
    enabled = true
    id = `local-track-${trackId++}`
    kind = 'audio'
    muted = false
    readyState = 'live'

    stop() {
      this.readyState = 'ended'
    }
  }

  class TestMediaStream {
    constructor(private tracks: MediaStreamTrack[] = []) {}

    getTracks() {
      return this.tracks
    }
  }

  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: TestMediaStream,
  })
  Object.defineProperty(globalThis, 'MediaStreamTrack', {
    configurable: true,
    value: TestMediaStreamTrack,
  })
  Object.defineProperty(window, 'MediaStream', {
    configurable: true,
    value: TestMediaStream,
  })
  Object.defineProperty(window, 'MediaStreamTrack', {
    configurable: true,
    value: TestMediaStreamTrack,
  })
}

function installAudioContextMock() {
  let analyserFloatSample = 0

  class TestAnalyserNode {
    fftSize = 256
    smoothingTimeConstant = 0
    connect = vi.fn()
    disconnect = vi.fn()

    getFloatTimeDomainData(samples: Float32Array) {
      samples.fill(analyserFloatSample)
    }
  }

  class TestAudioContext {
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() }
    }

    createAnalyser() {
      return new TestAnalyserNode()
    }

    resume() {
      return Promise.resolve()
    }

    close() {
      return Promise.resolve()
    }
  }

  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: TestAudioContext,
  })

  return {
    setAnalyserFloatSample(sample: number) {
      analyserFloatSample = sample
    },
  }
}

function installAnimationFrameMock() {
  let frameId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const request = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      const id = ++frameId
      callbacks.set(id, callback)
      return id
    })
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      callbacks.delete(id)
    })

  return {
    runFrame() {
      const pending = Array.from(callbacks.entries())
      callbacks.clear()
      pending.forEach(([, callback]) => callback(performance.now()))
    },
    restore() {
      request.mockRestore()
      cancel.mockRestore()
    },
  }
}

function createTrack() {
  const Track = (
    globalThis as typeof globalThis & {
      MediaStreamTrack: new () => MediaStreamTrack
    }
  ).MediaStreamTrack
  return new Track()
}

describe('LocalSpeakingDetector', () => {
  let detector: LocalSpeakingDetector
  let animationFrame: ReturnType<typeof installAnimationFrameMock>
  let audioContext: ReturnType<typeof installAudioContextMock>
  let changes: boolean[]

  beforeEach(() => {
    installMediaStreamMock()
    audioContext = installAudioContextMock()
    animationFrame = installAnimationFrameMock()
    changes = []
    detector = createLocalSpeakingDetector({
      onSpeakingChange: (speaking) => changes.push(speaking),
    })
  })

  afterEach(() => {
    detector.dispose()
    animationFrame.restore()
    Reflect.deleteProperty(window, 'AudioContext')
    Reflect.deleteProperty(window, 'MediaStream')
    Reflect.deleteProperty(window, 'MediaStreamTrack')
    Reflect.deleteProperty(globalThis, 'MediaStream')
    Reflect.deleteProperty(globalThis, 'MediaStreamTrack')
  })

  it('reports local mic speaking from low post-processed audio', () => {
    audioContext.setAnalyserFloatSample(0.002)

    detector.setTrack(createTrack())
    detector.setEnabled(true)
    animationFrame.runFrame()

    expect(changes.at(-1)).toBe(true)
  })

  it('clears local mic speaking when disabled', () => {
    audioContext.setAnalyserFloatSample(0.002)

    detector.setTrack(createTrack())
    detector.setEnabled(true)
    animationFrame.runFrame()
    detector.setEnabled(false)

    expect(changes).toEqual([true, false])
  })

  it('does not report silence as local speech', () => {
    audioContext.setAnalyserFloatSample(0)

    detector.setTrack(createTrack())
    detector.setEnabled(true)
    animationFrame.runFrame()

    expect(changes).toEqual([])
  })
})
