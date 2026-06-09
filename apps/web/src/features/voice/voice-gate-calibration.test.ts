import { describe, expect, it } from 'vitest'

import { computeVoiceGateThresholdFromSamples } from './voice-gate-calibration'

describe('computeVoiceGateThresholdFromSamples', () => {
  it('returns fallback when there are no samples', () => {
    expect(computeVoiceGateThresholdFromSamples([], -28)).toBe(-28)
  })

  it('raises threshold above the measured noise floor', () => {
    const threshold = computeVoiceGateThresholdFromSamples(
      [0.01, 0.012, 0.011, 0.013, 0.014],
      -28,
    )

    expect(threshold).toBeGreaterThan(-37.1)
    expect(threshold).toBeLessThanOrEqual(-16.5)
  })

  it('clamps very loud calibration input', () => {
    const threshold = computeVoiceGateThresholdFromSamples(
      Array.from({ length: 20 }, () => 0.2),
      -28,
    )

    expect(threshold).toBe(-16.5)
  })
})
