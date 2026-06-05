import { describe, expect, it } from 'vitest'

import { normalizeVoiceGateThreshold, voiceGateOpen } from './voice-gate'

describe('normalizeVoiceGateThreshold', () => {
  it('clamps threshold into the unit interval', () => {
    expect(normalizeVoiceGateThreshold(2)).toBe(1)
    expect(normalizeVoiceGateThreshold(-1)).toBe(0)
  })

  it('uses the fallback for invalid values', () => {
    expect(normalizeVoiceGateThreshold('bad', 0.04)).toBe(0.04)
  })
})

describe('voiceGateOpen', () => {
  it('stays open when the gate is disabled', () => {
    expect(voiceGateOpen(0, 0.5, false)).toBe(true)
  })

  it('opens when level reaches the threshold', () => {
    expect(voiceGateOpen(0.04, 0.04, true)).toBe(true)
    expect(voiceGateOpen(0.039, 0.04, true)).toBe(false)
  })
})
