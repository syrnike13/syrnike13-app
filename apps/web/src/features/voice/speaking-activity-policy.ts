export const SPEAKING_THRESHOLD_DB = -58
export const SPEAKING_CLOSE_HOLD_MS = 180

export type SpeakingPolicyState = Readonly<{
  speaking: boolean
  quietSince: number | null
}>

export function advanceSpeakingPolicy({
  state,
  levelDb,
  enabled,
  now,
}: {
  state: SpeakingPolicyState
  levelDb: number
  enabled: boolean
  now: number
}): SpeakingPolicyState {
  if (!enabled) return { speaking: false, quietSince: null }

  if (Number.isFinite(levelDb) && levelDb >= SPEAKING_THRESHOLD_DB) {
    return { speaking: true, quietSince: null }
  }

  if (!state.speaking) return { speaking: false, quietSince: null }

  const quietSince = state.quietSince ?? now
  return {
    speaking: now - quietSince < SPEAKING_CLOSE_HOLD_MS,
    quietSince,
  }
}
