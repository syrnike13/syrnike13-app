import {
  normalizeVoiceGateThresholdDb,
  rmsToDb,
} from './voice-gate-level'

export const VOICE_GATE_CALIBRATION_MS = 2_500
const CALIBRATION_MARGIN_DB = 4
const CALIBRATION_MIN_DB = rmsToDb(0.008)
const CALIBRATION_MAX_DB = rmsToDb(0.15)

export function computeVoiceGateThresholdFromSamples(
  samples: readonly number[],
  fallback: number,
) {
  if (samples.length === 0) {
    return normalizeVoiceGateThresholdDb(fallback)
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const percentileIndex = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * 0.9),
  )
  const noiseFloor = sorted[percentileIndex] ?? 0
  const thresholdDb = rmsToDb(noiseFloor) + CALIBRATION_MARGIN_DB

  return normalizeVoiceGateThresholdDb(
    Math.min(CALIBRATION_MAX_DB, Math.max(CALIBRATION_MIN_DB, thresholdDb)),
    fallback,
  )
}
