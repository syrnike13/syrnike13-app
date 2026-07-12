export const VOICE_TRANSITION_LIMIT = 8
export const VOICE_TRANSITION_WINDOW_MS = 10_000

function recentVoiceTransitionAttempts(attempts: readonly number[], now: number) {
  const windowStart = now - VOICE_TRANSITION_WINDOW_MS
  return attempts.filter((attemptAt) => attemptAt > windowStart)
}

export function voiceTransitionBlockedUntil(
  attempts: readonly number[],
  now: number,
) {
  const recent = recentVoiceTransitionAttempts(attempts, now)
  if (recent.length < VOICE_TRANSITION_LIMIT) return 0
  return recent[0] + VOICE_TRANSITION_WINDOW_MS
}

export function recordVoiceTransitionAttempt(
  attempts: readonly number[],
  now: number,
) {
  return [...recentVoiceTransitionAttempts(attempts, now), now]
}

export function createVoiceTransitionRateLimiter() {
  let attempts: number[] = []

  return {
    isBlocked(now: number) {
      return voiceTransitionBlockedUntil(attempts, now) > now
    },
    record(now: number) {
      attempts = recordVoiceTransitionAttempt(attempts, now)
    },
  }
}
