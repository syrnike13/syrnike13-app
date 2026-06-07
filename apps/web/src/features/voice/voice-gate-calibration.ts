import { normalizeVoiceGateThreshold } from './voice-gate'

export const VOICE_GATE_CALIBRATION_MS = 2_500
const CALIBRATION_MARGIN = 1.6
const CALIBRATION_OFFSET = 0.006
const CALIBRATION_MIN = 0.008
const CALIBRATION_MAX = 0.15

export function computeVoiceGateThresholdFromSamples(
  samples: readonly number[],
  fallback: number,
) {
  if (samples.length === 0) {
    return normalizeVoiceGateThreshold(fallback)
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const percentileIndex = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * 0.9),
  )
  const noiseFloor = sorted[percentileIndex] ?? 0
  const threshold = noiseFloor * CALIBRATION_MARGIN + CALIBRATION_OFFSET

  return normalizeVoiceGateThreshold(
    Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, threshold)),
    fallback,
  )
}
