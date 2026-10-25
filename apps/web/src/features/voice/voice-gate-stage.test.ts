// @vitest-environment jsdom

import { createContext, runInContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import workletSource from './voice-gate-worklet.js?raw'

import { VoiceGateStage } from './voice-gate-stage'

type FakeParameter = {
  value: number
  cancelScheduledValues: ReturnType<typeof vi.fn>
  setValueAtTime: ReturnType<typeof vi.fn>
}

class TestAudioWorkletNode {
  static instances: TestAudioWorkletNode[] = []

  readonly parameters = new Map<string, FakeParameter>()
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  port: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = {
    onmessage: null,
  }

  constructor(
    readonly context: TestAudioContext,
    readonly name: string,
    readonly options?: AudioWorkletNodeOptions,
  ) {
    for (const parameter of ['enabled', 'autoDynamic', 'thresholdDb']) {
      this.parameters.set(parameter, {
        value: 0,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
      })
    }
    TestAudioWorkletNode.instances.push(this)
  }
}

class TestGainNode {
  readonly gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
  }
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
}

class TestAnalyserNode {
  fftSize = 256
  smoothingTimeConstant = 0
  byteSample = 128
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()

  getByteTimeDomainData(samples: Uint8Array) {
    samples.fill(this.byteSample)
  }
}

class TestSourceNode {
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
}

class TestAudioContext {
  currentTime = 1
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) }
  readonly sources: TestSourceNode[] = []
  readonly gains: TestGainNode[] = []
  readonly analysers: TestAnalyserNode[] = []

  createMediaStreamSource() {
    const source = new TestSourceNode()
    this.sources.push(source)
    return source
  }

  createMediaStreamDestination() {
    const target = createTrack()
    return {
      stream: { getAudioTracks: () => [target] },
      disconnect: vi.fn(),
    }
  }

  createGain() {
    const gain = new TestGainNode()
    this.gains.push(gain)
    return gain
  }

  createAnalyser() {
    const analyser = new TestAnalyserNode()
    this.analysers.push(analyser)
    return analyser
  }
}

function createTrack() {
  return {
    enabled: true,
    id: 'track-1',
    kind: 'audio',
    muted: false,
    readyState: 'live',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack
}

function installGlobals() {
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()

  class TestMediaStream {
    constructor(private readonly tracks: MediaStreamTrack[]) {}

    getAudioTracks() {
      return this.tracks
    }
  }

  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: TestMediaStream,
  })
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: TestAudioWorkletNode,
  })

  const requestAnimationFrame = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      const id = ++frameId
      frames.set(id, callback)
      return id
    })
  const cancelAnimationFrame = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      frames.delete(id)
    })

  return {
    runFrames() {
      const pending = Array.from(frames.values())
      frames.clear()
      pending.forEach((callback) => callback(performance.now()))
    },
    requestAnimationFrame,
    restore() {
      requestAnimationFrame.mockRestore()
      cancelAnimationFrame.mockRestore()
    },
  }
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

function createWorkletHarness() {
  const messages: unknown[] = []
  type WorkletProcessor = {
    gain: number
    frames: number
    quietLevelHistory: number[]
    process: (
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ) => boolean
  }
  let Processor: (new () => WorkletProcessor) | null = null
  const registration: { current: (new () => WorkletProcessor) | null } = {
    current: null,
  }

  class TestAudioWorkletProcessor {
    readonly port = {
      postMessage: (message: unknown) => messages.push(message),
    }
  }

  const context = createContext({
    AudioWorkletProcessor: TestAudioWorkletProcessor,
    registerProcessor: (_name: string, processor: typeof Processor) => {
      registration.current = processor
    },
    sampleRate: 48_000,
    Math,
    Number,
    Array,
    Float32Array,
  })
  runInContext(workletSource, context)
  Processor = registration.current
  if (!Processor) throw new Error('Voice gate worklet did not register a processor')
  return { Processor, messages }
}

describe('VoiceGateStage', () => {
  let globals: ReturnType<typeof installGlobals>
  let context: TestAudioContext

  beforeEach(() => {
    globals = installGlobals()
    context = new TestAudioContext()
    TestAudioWorkletNode.instances = []
    setVisibility('visible')
  })

  afterEach(() => {
    globals.restore()
    vi.restoreAllMocks()
  })

  it('routes the microphone through the audio worklet', async () => {
    const stage = new VoiceGateStage(-28)
    const metrics: Array<{ inputDb: number; thresholdDb: number; open: boolean }> = []
    stage.start(context as unknown as AudioContext, createTrack(), {
      enabled: true,
      autoDynamic: true,
      onMetrics: (next) => metrics.push(next),
    })
    await vi.waitFor(() => {
      expect(TestAudioWorkletNode.instances).toHaveLength(1)
    })

    const node = TestAudioWorkletNode.instances[0]
    const source = context.sources[0]
    const gain = context.gains[0]
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1)
    expect(source?.disconnect).toHaveBeenCalledWith(gain)
    expect(source?.connect).toHaveBeenCalledWith(node)
    expect(node.connect).toHaveBeenCalledWith(gain)
    expect(node.parameters.get('enabled')?.setValueAtTime).toHaveBeenCalledWith(
      1,
      context.currentTime,
    )
    expect(
      node.parameters.get('autoDynamic')?.setValueAtTime,
    ).toHaveBeenCalledWith(1, context.currentTime)
    expect(globals.requestAnimationFrame).not.toHaveBeenCalled()

    node.port.onmessage?.({
      data: { inputDb: -20, thresholdDb: -28, open: true },
    } as MessageEvent<unknown>)
    expect(metrics).toEqual([
      { inputDb: -20, thresholdDb: -28, open: true },
    ])

    stage.destroy()
  })

  it('keeps the microphone open while the tab is hidden when the worklet is unavailable', async () => {
    context.audioWorklet.addModule.mockRejectedValueOnce(new Error('unsupported'))
    vi.spyOn(Date, 'now').mockReturnValue(1_000)

    const stage = new VoiceGateStage(-28)
    stage.start(context as unknown as AudioContext, createTrack(), {
      enabled: true,
      manualThresholdDb: -28,
    })
    await vi.waitFor(() => {
      expect(globals.requestAnimationFrame).toHaveBeenCalled()
    })

    const analyser = context.analysers[0]
    const gain = context.gains[0]
    if (!analyser || !gain) throw new Error('Audio graph was not created')

    analyser.byteSample = 128
    vi.spyOn(Date, 'now').mockReturnValue(1_200)
    globals.runFrames()
    globals.runFrames()
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, 0.02)

    setVisibility('hidden')

    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 1, 0.008)

    stage.destroy()
  })
})

describe('voice gate worklet', () => {
  it('closes on silence and reopens on voice without requestAnimationFrame', () => {
    const { Processor, messages } = createWorkletHarness()
    const processor = new Processor()
    const parameters = {
      enabled: new Float32Array([1]),
      autoDynamic: new Float32Array([1]),
      thresholdDb: new Float32Array([-28]),
    }

    const render = (amplitude: number) => {
      const input = [
        Float32Array.from({ length: 128 }, (_, index) =>
          amplitude === 0 ? 0 : amplitude * Math.sin(index / 4),
        ),
      ]
      const output = [new Float32Array(128)]
      processor.process([input], [output], parameters)
      return output[0]
    }

    for (let block = 0; block < 240; block += 1) render(0)
    expect(processor.gain).toBeLessThan(0.05)

    let audible = 0
    for (let block = 0; block < 20; block += 1) {
      const output = render(0.25)
      audible += output.reduce((sum, sample) => sum + Math.abs(sample), 0)
    }
    expect(processor.gain).toBeGreaterThan(0.8)
    expect(audible).toBeGreaterThan(0)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('samples the auto threshold at the animation-frame rate', () => {
    const { Processor } = createWorkletHarness()
    const processor = new Processor()
    const parameters = {
      enabled: new Float32Array([1]),
      autoDynamic: new Float32Array([1]),
      thresholdDb: new Float32Array([-28]),
    }
    const quiet = [Float32Array.from({ length: 128 }, (_, index) => 0.003 * Math.sin(index / 4))]

    // Half a second of render quanta at 48 kHz.
    for (let block = 0; block < 188; block += 1) {
      processor.process([quiet], [[new Float32Array(128)]], parameters)
    }

    expect(processor.quietLevelHistory.length).toBeGreaterThanOrEqual(29)
    expect(processor.quietLevelHistory.length).toBeLessThanOrEqual(31)
  })
})
