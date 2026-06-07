import { describe, expect, it } from 'vitest'

import { computeVoiceGateThresholdFromSamples } from './voice-gate-calibration'

describe('computeVoiceGateThresholdFromSamples', () => {
  it('returns fallback when there are no samples', () => {
    expect(computeVoiceGateThresholdFromSamples([], 0.04)).toBe(0.04)
  })

  it('raises threshold above the measured noise floor', () => {
    const threshold = computeVoiceGateThresholdFromSamples(
      [0.01, 0.012, 0.011, 0.013, 0.014],
      0.04,
    )

    expect(threshold).toBeGreaterThan(0.014)
    expect(threshold).toBeLessThanOrEqual(0.15)
  })

  it('clamps very loud calibration input', () => {
    const threshold = computeVoiceGateThresholdFromSamples(
      Array.from({ length: 20 }, () => 0.2),
      0.04,
    )

    expect(threshold).toBe(0.15)
  })
})
