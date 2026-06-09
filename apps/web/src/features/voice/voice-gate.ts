import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  normalizeVoiceGateThresholdDb,
  VOICE_GATE_DB_MIN,
} from './voice-gate-level'

/** @deprecated Linear threshold kept for migration only. */
export const DEFAULT_VOICE_GATE_THRESHOLD = 0.04

/** @deprecated */
export function normalizeVoiceGateThreshold(
  value: unknown,
  fallback = DEFAULT_VOICE_GATE_THRESHOLD,
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, Number(value.toFixed(3))))
}

export function voiceGateOpenDb(
  levelDb: number,
  thresholdDb: number,
  enabled: boolean,
) {
  if (!enabled) return true
  return (
    normalizeVoiceGateThresholdDb(levelDb, VOICE_GATE_DB_MIN) >=
    normalizeVoiceGateThresholdDb(
      thresholdDb,
      DEFAULT_VOICE_GATE_THRESHOLD_DB,
    )
  )
}
