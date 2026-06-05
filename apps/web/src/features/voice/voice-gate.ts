export const DEFAULT_VOICE_GATE_THRESHOLD = 0.04

export function normalizeVoiceGateThreshold(
  value: unknown,
  fallback = DEFAULT_VOICE_GATE_THRESHOLD,
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, Number(value.toFixed(3))))
}

export function voiceGateOpen(
  level: number,
  threshold: number,
  enabled: boolean,
) {
  if (!enabled) return true
  return normalizeVoiceGateThreshold(level, 0) >=
    normalizeVoiceGateThreshold(threshold)
}
