export const VOICE_GATE_DB_MIN = -60
export const VOICE_GATE_DB_MAX = 0
export const DEFAULT_VOICE_GATE_THRESHOLD_DB = -28
export const VOICE_GATE_AUTO_MARGIN_DB = 6

export function rmsFromByteTimeDomain(samples: Uint8Array) {
  let sum = 0
  for (const sample of samples) {
    const centered = (sample - 128) / 128
    sum += centered * centered
  }
  return Math.sqrt(sum / samples.length)
}

export function rmsFromFloatTimeDomain(samples: Float32Array) {
  let sum = 0
  for (const sample of samples) {
    sum += sample * sample
  }
  return Math.sqrt(sum / samples.length)
}

export function rmsToDb(rms: number) {
  if (!Number.isFinite(rms) || rms <= 0.000_000_1) {
    return VOICE_GATE_DB_MIN
  }
  return Math.max(
    VOICE_GATE_DB_MIN,
    Math.min(VOICE_GATE_DB_MAX, 20 * Math.log10(rms)),
  )
}

export function dbToRms(db: number) {
  return Math.pow(10, db / 20)
}

export function linearThresholdToDb(linear: number) {
  return normalizeVoiceGateThresholdDb(rmsToDb(linear))
}

export function normalizeVoiceGateThresholdDb(
  value: unknown,
  fallback = DEFAULT_VOICE_GATE_THRESHOLD_DB,
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(
    VOICE_GATE_DB_MAX,
    Math.max(VOICE_GATE_DB_MIN, Number(value.toFixed(1))),
  )
}

export function gateDbToPosition(db: number) {
  const clamped = normalizeVoiceGateThresholdDb(db)
  return (clamped - VOICE_GATE_DB_MIN) / (VOICE_GATE_DB_MAX - VOICE_GATE_DB_MIN)
}

export function positionToGateDb(position: number) {
  const clamped = Math.min(1, Math.max(0, position))
  return normalizeVoiceGateThresholdDb(
    VOICE_GATE_DB_MIN +
      clamped * (VOICE_GATE_DB_MAX - VOICE_GATE_DB_MIN),
  )
}

export function formatGateThresholdDb(db: number) {
  return `${normalizeVoiceGateThresholdDb(db).toFixed(1)} dB`
}
