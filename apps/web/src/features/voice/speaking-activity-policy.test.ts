import { describe, expect, it } from 'vitest'

import {
  SPEAKING_CLOSE_HOLD_MS,
  SPEAKING_THRESHOLD_DB,
  advanceSpeakingPolicy,
} from './speaking-activity-policy'

describe('speaking activity policy', () => {
  it('opens immediately at the shared threshold', () => {
    expect(
      advanceSpeakingPolicy({
        state: { speaking: false, quietSince: null },
        levelDb: SPEAKING_THRESHOLD_DB,
        enabled: true,
        now: 100,
      }),
    ).toEqual({ speaking: true, quietSince: null })
  })

  it('holds a speaking state briefly through quiet frames', () => {
    const started = advanceSpeakingPolicy({
      state: { speaking: false, quietSince: null },
      levelDb: SPEAKING_THRESHOLD_DB,
      enabled: true,
      now: 100,
    })
    const quiet = advanceSpeakingPolicy({
      state: started,
      levelDb: SPEAKING_THRESHOLD_DB - 1,
      enabled: true,
      now: 100 + SPEAKING_CLOSE_HOLD_MS - 1,
    })
    expect(quiet.speaking).toBe(true)

    expect(
      advanceSpeakingPolicy({
        state: quiet,
        levelDb: SPEAKING_THRESHOLD_DB - 1,
        enabled: true,
        now: (quiet.quietSince ?? 0) + SPEAKING_CLOSE_HOLD_MS + 1,
      }),
    ).toEqual({
      speaking: false,
      quietSince: quiet.quietSince,
    })
  })

  it('closes immediately when the source is disabled', () => {
    expect(
      advanceSpeakingPolicy({
        state: { speaking: true, quietSince: 100 },
        levelDb: SPEAKING_THRESHOLD_DB,
        enabled: false,
        now: 200,
      }),
    ).toEqual({ speaking: false, quietSince: null })
  })
})
