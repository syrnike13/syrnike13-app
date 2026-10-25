import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  normalizeVoiceGateThresholdDb,
  rmsFromByteTimeDomain,
  rmsToDb,
  VOICE_GATE_AUTO_MARGIN_DB,
} from './voice-gate-level'
import { voiceGateOpenDb } from './voice-gate'
import voiceGateWorkletUrl from './voice-gate-worklet.js?url'

const OPEN_HOLD_MS = 0
const CLOSE_HOLD_MS = 180
const QUIET_HISTORY_SIZE = 60
const MIN_QUIET_SAMPLES = 16
const QUIET_FLOOR_PERCENTILE = 0.2
const NOISE_FLOOR_ALPHA = 0.05

const GATE_PROCESSOR_NAME = 'syrnike-voice-gate'

// AudioWorklet modules are registered per AudioContext. A processor can be
// instantiated many times (microphone publication, settings meter, preview)
// against the same context, so load the module once.
const workletModuleLoads = new WeakMap<AudioContext, Promise<void>>()

export type VoiceGateMetrics = {
  inputDb: number
  thresholdDb: number
  open: boolean
}

export type VoiceGateStageOptions = {
  enabled?: boolean
  autoDynamic?: boolean
  manualThresholdDb?: number
  onMetrics?: (metrics: VoiceGateMetrics) => void
}

export class VoiceGateStage {
  #manualThresholdDb: number
  #enabled = true
  #autoDynamic = false
  #thresholdDb = DEFAULT_VOICE_GATE_THRESHOLD_DB
  #noiseFloorDb = DEFAULT_VOICE_GATE_THRESHOLD_DB - VOICE_GATE_AUTO_MARGIN_DB
  #quietLevelHistory: number[] = []
  #context: AudioContext | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #analyser: AnalyserNode | null = null
  #gain: GainNode | null = null
  #destination: MediaStreamAudioDestinationNode | null = null
  #samples: Uint8Array<ArrayBuffer> | null = null
  #worklet: AudioWorkletNode | null = null
  #fallbackActive = false
  #frame: number | null = null
  #open = true
  #lastGateChangeAt = 0
  #outputTrack: MediaStreamTrack | null = null
  #onMetrics: ((metrics: VoiceGateMetrics) => void) | null = null
  #visibilityListener: (() => void) | null = null
  #disposed = false

  constructor(thresholdDb: number) {
    this.#manualThresholdDb = normalizeVoiceGateThresholdDb(thresholdDb)
    this.#thresholdDb = this.#manualThresholdDb
  }

  start(
    context: AudioContext,
    track: MediaStreamTrack,
    options?: VoiceGateStageOptions,
  ) {
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const analyser = context.createAnalyser()
    const gain = context.createGain()
    const destination = context.createMediaStreamDestination()

    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.35
    source.connect(analyser)
    source.connect(gain)
    gain.connect(destination)

    this.#context = context
    this.#source = source
    this.#analyser = analyser
    this.#gain = gain
    this.#destination = destination
    this.#samples = new Uint8Array(analyser.fftSize)
    this.#outputTrack = destination.stream.getAudioTracks()[0] ?? null
    this.#open = true
    this.#lastGateChangeAt = Date.now()
    this.#enabled = options?.enabled ?? true
    this.#autoDynamic = options?.autoDynamic ?? false
    this.#onMetrics = options?.onMetrics ?? null
    this.#quietLevelHistory = []

    if (options?.manualThresholdDb != null) {
      this.#manualThresholdDb = normalizeVoiceGateThresholdDb(
        options.manualThresholdDb,
      )
      this.#thresholdDb = this.#manualThresholdDb
    } else if (!this.#autoDynamic) {
      this.#thresholdDb = this.#manualThresholdDb
    }

    gain.gain.value = 1
    this.#startWorkletOrFallback(context)

    return this.#outputTrack
  }

  updateOptions(options: VoiceGateStageOptions) {
    this.#enabled = options.enabled ?? true
    if (options.autoDynamic) {
      this.#autoDynamic = true
      this.#quietLevelHistory = []
    } else if (options.manualThresholdDb != null) {
      this.#autoDynamic = false
      this.#manualThresholdDb = normalizeVoiceGateThresholdDb(
        options.manualThresholdDb,
      )
      this.#thresholdDb = this.#manualThresholdDb
    }

    if (options.onMetrics) {
      this.#onMetrics = options.onMetrics
    }

    this.#applyWorkletParameters()
    if (this.#fallbackActive && !this.#enabled) this.#setFallbackGain(1)
  }

  destroy() {
    this.#disposed = true
    if (this.#frame !== null) {
      cancelAnimationFrame(this.#frame)
      this.#frame = null
    }
    this.#removeVisibilityListener()
    if (this.#worklet) {
      this.#worklet.port.onmessage = null
      this.#worklet.onprocessorerror = null
      this.#worklet.disconnect()
      this.#worklet = null
    }
    this.#source?.disconnect()
    this.#analyser?.disconnect()
    this.#gain?.disconnect()
    this.#destination?.disconnect()
    this.#outputTrack?.stop()
    this.#context = null
    this.#source = null
    this.#analyser = null
    this.#gain = null
    this.#destination = null
    this.#samples = null
    this.#outputTrack = null
    this.#open = true
    this.#lastGateChangeAt = 0
    this.#quietLevelHistory = []
    this.#onMetrics = null
  }

  #startWorkletOrFallback(context: AudioContext) {
    const load = loadGateWorkletModule(context)
    if (!load) {
      this.#startFallback()
      return
    }
    void load.then(
      () => {
        if (this.#disposed || this.#context !== context) return
        if (!this.#attachWorklet(context)) this.#startFallback()
      },
      () => {
        if (this.#disposed || this.#context !== context) return
        this.#startFallback()
      },
    )
  }

  #attachWorklet(context: AudioContext) {
    const source = this.#source
    const gain = this.#gain
    if (!source || !gain) return false
    if (typeof AudioWorkletNode !== 'function') return false

    let node: AudioWorkletNode
    try {
      node = new AudioWorkletNode(context, GATE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      })
    } catch {
      return false
    }

    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const metrics = parseWorkletMetrics(event.data)
      if (metrics) this.#onMetrics?.(metrics)
    }
    node.onprocessorerror = () => {
      if (this.#disposed || this.#worklet !== node) return
      this.#worklet = null
      node.port.onmessage = null
      node.onprocessorerror = null
      const currentSource = this.#source
      const currentGain = this.#gain
      if (currentSource && currentGain) currentSource.connect(currentGain)
      node.disconnect()
      this.#startFallback()
    }
    this.#worklet = node
    this.#applyWorkletParameters()

    try {
      source.disconnect(gain)
      source.connect(node)
      node.connect(gain)
    } catch {
      node.port.onmessage = null
      node.disconnect()
      this.#worklet = null
      source.connect(gain)
      return false
    }
    return true
  }

  #applyWorkletParameters() {
    const node = this.#worklet
    const context = this.#context
    if (!node || !context) return
    const now = context.currentTime
    setWorkletParameter(node, 'enabled', this.#enabled ? 1 : 0, now)
    setWorkletParameter(node, 'autoDynamic', this.#autoDynamic ? 1 : 0, now)
    setWorkletParameter(node, 'thresholdDb', this.#thresholdDb, now)
  }

  #startFallback() {
    if (this.#disposed || this.#fallbackActive || !this.#context) return
    this.#fallbackActive = true
    this.#addVisibilityListener()
    this.#scheduleTick()
  }

  #addVisibilityListener() {
    if (this.#visibilityListener || typeof document === 'undefined') return
    this.#visibilityListener = () => {
      if (document.visibilityState === 'hidden') {
        // rAF is paused in hidden tabs, so the gate cannot measure the
        // microphone there. Fail open instead of leaving the microphone
        // muted for the whole time the tab is in the background.
        this.#stopTicks()
        this.#open = true
        this.#lastGateChangeAt = Date.now()
        this.#setFallbackGain(1)
        return
      }
      this.#scheduleTick()
    }
    document.addEventListener('visibilitychange', this.#visibilityListener)
  }

  #removeVisibilityListener() {
    if (!this.#visibilityListener || typeof document === 'undefined') return
    document.removeEventListener('visibilitychange', this.#visibilityListener)
    this.#visibilityListener = null
  }

  #scheduleTick() {
    if (
      this.#disposed ||
      this.#frame !== null ||
      typeof document === 'undefined' ||
      document.visibilityState === 'hidden'
    ) {
      return
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null
      this.#tick()
      this.#scheduleTick()
    })
  }

  #stopTicks() {
    if (this.#frame === null) return
    cancelAnimationFrame(this.#frame)
    this.#frame = null
  }

  #setFallbackGain(target: number) {
    const gain = this.#gain
    const context = this.#context
    if (!gain || !context) return
    const time = context.currentTime
    gain.gain.cancelScheduledValues(time)
    gain.gain.setTargetAtTime(target, time, target > 0 ? 0.008 : 0.02)
  }

  #updateAutoThreshold(inputDb: number, quiet: boolean) {
    if (!quiet) return

    this.#quietLevelHistory.push(inputDb)
    if (this.#quietLevelHistory.length > QUIET_HISTORY_SIZE) {
      this.#quietLevelHistory.shift()
    }

    if (this.#quietLevelHistory.length < MIN_QUIET_SAMPLES) return

    const sorted = [...this.#quietLevelHistory].sort((left, right) => left - right)
    const index = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * QUIET_FLOOR_PERCENTILE),
    )
    const estimatedFloor = sorted[index] ?? this.#noiseFloorDb
    this.#noiseFloorDb +=
      (estimatedFloor - this.#noiseFloorDb) * NOISE_FLOOR_ALPHA
    this.#thresholdDb = normalizeVoiceGateThresholdDb(
      this.#noiseFloorDb + VOICE_GATE_AUTO_MARGIN_DB,
    )
  }

  #emitMetrics(inputDb: number) {
    this.#onMetrics?.({
      inputDb,
      thresholdDb: this.#thresholdDb,
      open: this.#open,
    })
  }

  #tick() {
    if (!this.#analyser || !this.#samples || !this.#gain) return

    this.#analyser.getByteTimeDomainData(this.#samples)
    const inputDb = rmsToDb(rmsFromByteTimeDomain(this.#samples))

    if (this.#enabled && this.#autoDynamic) {
      const quiet = !voiceGateOpenDb(inputDb, this.#thresholdDb, true)
      this.#updateAutoThreshold(inputDb, quiet)
    } else {
      this.#thresholdDb = this.#manualThresholdDb
    }

    const shouldOpen = voiceGateOpenDb(inputDb, this.#thresholdDb, this.#enabled)
    const now = Date.now()
    const holdMs = shouldOpen ? OPEN_HOLD_MS : CLOSE_HOLD_MS

    if (shouldOpen !== this.#open) {
      if (now - this.#lastGateChangeAt >= holdMs) {
        this.#open = shouldOpen
        this.#lastGateChangeAt = now
        this.#setFallbackGain(shouldOpen ? 1 : 0)
      }
    } else {
      this.#lastGateChangeAt = now
    }

    this.#emitMetrics(inputDb)
  }
}

function loadGateWorkletModule(context: AudioContext) {
  if (!context.audioWorklet) return null
  const cached = workletModuleLoads.get(context)
  if (cached) return cached
  const load = context.audioWorklet.addModule(voiceGateWorkletUrl).catch(
    (error) => {
      workletModuleLoads.delete(context)
      throw error
    },
  )
  workletModuleLoads.set(context, load)
  return load
}

function setWorkletParameter(
  node: AudioWorkletNode,
  name: string,
  value: number,
  time: number,
) {
  const parameter = node.parameters.get(name)
  if (!parameter) return
  parameter.cancelScheduledValues(time)
  parameter.setValueAtTime(value, time)
}

function parseWorkletMetrics(value: unknown): VoiceGateMetrics | null {
  if (!value || typeof value !== 'object') return null
  const metrics = value as Partial<VoiceGateMetrics>
  if (
    typeof metrics.inputDb !== 'number' ||
    !Number.isFinite(metrics.inputDb) ||
    typeof metrics.thresholdDb !== 'number' ||
    !Number.isFinite(metrics.thresholdDb) ||
    typeof metrics.open !== 'boolean'
  ) {
    return null
  }
  return {
    inputDb: metrics.inputDb,
    thresholdDb: metrics.thresholdDb,
    open: metrics.open,
  }
}
