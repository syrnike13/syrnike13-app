import { describe, expect, it } from 'vitest'

import {
  effectiveVoiceGateStageOptions,
  resolveVoiceGateStageOptions,
} from './voice-gate-session'

const basePrefs = {
  voiceGateEnabled: true,
  voiceGateThresholdDb: -28,
  voiceGateAutoThreshold: true,
} as const

describe('resolveVoiceGateStageOptions', () => {
  it('enables dynamic auto threshold when auto mode is on', () => {
    expect(resolveVoiceGateStageOptions(basePrefs)).toEqual({
      enabled: true,
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
      enabled: true,
      manualThresholdDb: -22,
    })
  })

  it('keeps metrics enabled while bypassing the gate when the gate is off', () => {
    expect(
      resolveVoiceGateStageOptions({
        ...basePrefs,
        voiceGateEnabled: false,
        voiceGateThresholdDb: -22,
      }),
    ).toEqual({
      enabled: false,
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
