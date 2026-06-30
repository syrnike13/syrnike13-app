import { describe, expect, it } from 'vitest'

import {
  createVoiceTransitionRateLimiter,
  recordVoiceTransitionAttempt,
  voiceTransitionBlockedUntil,
} from './voice-transition-rate-limit'

describe('voice transition rate limit', () => {
  it('allows up to 8 voice transitions in a 10 second window', () => {
    let attempts: number[] = []

    for (let index = 0; index < 8; index += 1) {
      const now = 1_000 + index * 1_000
      expect(voiceTransitionBlockedUntil(attempts, now)).toBe(0)
      attempts = recordVoiceTransitionAttempt(attempts, now)
    }

    expect(voiceTransitionBlockedUntil(attempts, 8_500)).toBe(11_000)
  })

  it('unblocks as soon as the oldest transition leaves the window', () => {
    const attempts = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000]

    expect(voiceTransitionBlockedUntil(attempts, 10_999)).toBe(11_000)
    expect(voiceTransitionBlockedUntil(attempts, 11_000)).toBe(0)
  })

  it('keeps transition attempt state inside a small limiter object', () => {
    const limiter = createVoiceTransitionRateLimiter()

    for (let index = 0; index < 8; index += 1) {
      const now = 1_000 + index * 1_000
      expect(limiter.isBlocked(now)).toBe(false)
      limiter.record(now)
    }

    expect(limiter.isBlocked(8_500)).toBe(true)
    expect(limiter.isBlocked(11_000)).toBe(false)
  })
})
