import { describe, expect, it } from 'vitest'

import {
  effectiveVoiceGateStageOptions,
  resolveVoiceGateStageOptions,
} from './voice-gate-session'

const basePrefs = {
  voiceGateThresholdDb: -28,
  voiceGateAutoThreshold: true,
} as const

describe('resolveVoiceGateStageOptions', () => {
  it('enables dynamic auto threshold when auto mode is on', () => {
    expect(resolveVoiceGateStageOptions(basePrefs)).toEqual({
      autoDynamic: true,
    })
  })

  it('uses manual threshold when auto mode is off', () => {
    expect(
      resolveVoiceGateStageOptions({
        ...basePrefs,
        voiceGateAutoThreshold: false,
        voiceGateThresholdDb: -22,
      }),
    ).toEqual({
      manualThresholdDb: -22,
    })
  })
})

describe('effectiveVoiceGateStageOptions', () => {
  it('falls back to manual threshold when auto is disabled', () => {
    expect(
      effectiveVoiceGateStageOptions(undefined, false, -24),
    ).toEqual({
      manualThresholdDb: -24,
    })
  })
})
