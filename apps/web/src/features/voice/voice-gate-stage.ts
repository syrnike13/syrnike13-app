import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  normalizeVoiceGateThresholdDb,
  rmsFromByteTimeDomain,
  rmsToDb,
  VOICE_GATE_AUTO_MARGIN_DB,
} from './voice-gate-level'
import { voiceGateOpenDb } from './voice-gate'

const OPEN_HOLD_MS = 0
const CLOSE_HOLD_MS = 180
const QUIET_HISTORY_SIZE = 60
const MIN_QUIET_SAMPLES = 16
const QUIET_FLOOR_PERCENTILE = 0.2
const NOISE_FLOOR_ALPHA = 0.05

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
  #samples: Uint8Array | null = null
  #frame: number | null = null
  #open = true
  #lastGateChangeAt = 0
  #outputTrack: MediaStreamTrack | null = null
  #onMetrics: ((metrics: VoiceGateMetrics) => void) | null = null
  #resolveCalibrated: (() => void) | null = null
  #calibratedPromise: Promise<void> | null = null

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
    this.#calibratedPromise = new Promise((resolve) => {
      this.#resolveCalibrated = resolve
    })

    if (options?.manualThresholdDb != null) {
      this.#manualThresholdDb = normalizeVoiceGateThresholdDb(
        options.manualThresholdDb,
      )
      this.#thresholdDb = this.#manualThresholdDb
    } else if (!this.#autoDynamic) {
      this.#thresholdDb = this.#manualThresholdDb
    }

    gain.gain.value = 1
    this.#finishCalibrationReady()
    this.#scheduleTick()

    return this.#outputTrack
  }

  whenCalibrated() {
    return this.#calibratedPromise ?? Promise.resolve()
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
  }

  destroy() {
    if (this.#frame !== null) {
      cancelAnimationFrame(this.#frame)
      this.#frame = null
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
    this.#resolveCalibrated = null
    this.#calibratedPromise = null
  }

  #finishCalibrationReady() {
    this.#resolveCalibrated?.()
    this.#resolveCalibrated = null
  }

  #scheduleTick() {
    this.#frame = requestAnimationFrame(() => {
      this.#tick()
      this.#scheduleTick()
    })
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
        const time = this.#context?.currentTime ?? 0
        if (shouldOpen) {
          this.#gain.gain.cancelScheduledValues(time)
          this.#gain.gain.setTargetAtTime(1, time, 0.008)
        } else {
          this.#gain.gain.cancelScheduledValues(time)
          this.#gain.gain.setTargetAtTime(0, time, 0.02)
        }
      }
    } else {
      this.#lastGateChangeAt = now
    }

    this.#emitMetrics(inputDb)
  }
}
