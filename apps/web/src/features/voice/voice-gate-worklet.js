/*
 * Voice gate AudioWorklet.
 *
 * The gate must run on the audio rendering thread, not from
 * requestAnimationFrame: browsers pause rAF in hidden tabs, which used to
 * freeze the gate gain and cut the microphone while the user was on another
 * tab. AudioWorklet processors keep running while the tab is hidden.
 *
 * Keep this file dependency-free: it is loaded by the browser as a separate
 * module, not bundled with the application graph.
 */

const DB_MIN = -60
const DB_MAX = 0
const DEFAULT_THRESHOLD_DB = -28
const AUTO_MARGIN_DB = 6
const CLOSE_HOLD_MS = 180
const QUIET_HISTORY_SIZE = 60
const MIN_QUIET_SAMPLES = 16
const QUIET_FLOOR_PERCENTILE = 0.2
const NOISE_FLOOR_ALPHA = 0.05
const OPEN_TIME_CONSTANT_S = 0.008
const CLOSE_TIME_CONSTANT_S = 0.02
const METRICS_INTERVAL_S = 0.033

function clampDb(value) {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD_DB
  return Math.min(DB_MAX, Math.max(DB_MIN, Number(value.toFixed(1))))
}

function rmsToDb(rms) {
  if (!Number.isFinite(rms) || rms <= 0.000_000_1) return DB_MIN
  return Math.max(DB_MIN, Math.min(DB_MAX, 20 * Math.log10(rms)))
}

class SyrnikeVoiceGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'enabled',
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'autoDynamic',
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'thresholdDb',
        defaultValue: DEFAULT_THRESHOLD_DB,
        minValue: DB_MIN,
        maxValue: DB_MAX,
        automationRate: 'k-rate',
      },
    ]
  }

  constructor() {
    super()
    this.open = true
    this.enabled = true
    this.autoDynamic = true
    this.thresholdDb = DEFAULT_THRESHOLD_DB
    this.noiseFloorDb = DEFAULT_THRESHOLD_DB - AUTO_MARGIN_DB
    this.quietLevelHistory = []
    this.lastGateChangeMs = 0
    this.gain = 1
    this.frames = 0
    this.lastMetricsFrame = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    const frames = input?.[0]?.length ?? output?.[0]?.length ?? 128
    const enabled = (parameters.enabled?.[0] ?? 1) > 0.5
    const autoDynamic = (parameters.autoDynamic?.[0] ?? 1) > 0.5
    const manualThresholdDb = clampDb(parameters.thresholdDb?.[0])
    const nowMs = (this.frames / sampleRate) * 1000

    if (enabled !== this.enabled || (autoDynamic && !this.autoDynamic)) {
      this.quietLevelHistory = []
    }
    this.enabled = enabled
    this.autoDynamic = autoDynamic

    const inputDb = this.measureDb(input)
    if (enabled && autoDynamic) {
      this.updateAutoThreshold(inputDb)
    } else {
      this.thresholdDb = manualThresholdDb
    }

    const shouldOpen = enabled ? inputDb >= this.thresholdDb : true
    const holdMs = shouldOpen ? 0 : CLOSE_HOLD_MS
    if (shouldOpen !== this.open) {
      if (nowMs - this.lastGateChangeMs >= holdMs) {
        this.open = shouldOpen
        this.lastGateChangeMs = nowMs
      }
    } else {
      this.lastGateChangeMs = nowMs
    }

    const target = this.open ? 1 : 0
    const timeConstant = target > this.gain
      ? OPEN_TIME_CONSTANT_S
      : CLOSE_TIME_CONSTANT_S
    const coefficient = 1 - Math.exp(-1 / (timeConstant * sampleRate))
    const outputChannels = output?.length ?? 0
    const inputChannels = input?.length ?? 0
    let gain = this.gain
    for (let frame = 0; frame < frames; frame += 1) {
      gain += (target - gain) * coefficient
      for (let channel = 0; channel < outputChannels; channel += 1) {
        const destination = output[channel]
        if (!destination) continue
        const source = channel < inputChannels ? input[channel] : null
        destination[frame] = source ? source[frame] * gain : 0
      }
    }
    this.gain = gain

    this.frames += frames
    if (
      (this.frames - this.lastMetricsFrame) / sampleRate >= METRICS_INTERVAL_S
    ) {
      this.lastMetricsFrame = this.frames
      this.port.postMessage({
        inputDb,
        thresholdDb: this.thresholdDb,
        open: this.open,
      })
    }
    return true
  }

  measureDb(input) {
    const channel = input?.[0]
    if (!channel || channel.length === 0) return DB_MIN
    let sum = 0
    for (let index = 0; index < channel.length; index += 1) {
      sum += channel[index] * channel[index]
    }
    return rmsToDb(Math.sqrt(sum / channel.length))
  }

  updateAutoThreshold(inputDb) {
    if (inputDb >= this.thresholdDb) return

    this.quietLevelHistory.push(inputDb)
    if (this.quietLevelHistory.length > QUIET_HISTORY_SIZE) {
      this.quietLevelHistory.shift()
    }
    if (this.quietLevelHistory.length < MIN_QUIET_SAMPLES) return

    const sorted = [...this.quietLevelHistory].sort((left, right) => left - right)
    const index = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * QUIET_FLOOR_PERCENTILE),
    )
    const estimatedFloor = sorted[index] ?? this.noiseFloorDb
    this.noiseFloorDb +=
      (estimatedFloor - this.noiseFloorDb) * NOISE_FLOOR_ALPHA
    this.thresholdDb = clampDb(this.noiseFloorDb + AUTO_MARGIN_DB)
  }
}

registerProcessor('syrnike-voice-gate', SyrnikeVoiceGateProcessor)
