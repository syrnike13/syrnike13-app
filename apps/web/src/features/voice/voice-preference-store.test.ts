import { describe, expect, it, beforeEach } from 'vitest'

import {
  effectiveVoiceJoinPreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'

describe('voicePreferenceStore', () => {
  beforeEach(() => {
    voicePreferenceStore.setMicEnabled(true)
    voicePreferenceStore.setDeafened(false)
    voicePreferenceStore.setVoiceGateEnabled(false)
    voicePreferenceStore.setVoiceGateThreshold(0.04)
    voicePreferenceStore.setAutoBalanceEnabled(false)
    voicePreferenceStore.setAutoBalanceStrength(0.5)
  })

  it('persists mic preference', () => {
    voicePreferenceStore.setMicEnabled(false)
    expect(voicePreferenceStore.getMicEnabled()).toBe(false)
    expect(voicePreferenceStore.getMicEnabled()).toBe(false)
  })

  it('persists deafen preference', () => {
    voicePreferenceStore.setDeafened(true)
    expect(voicePreferenceStore.getDeafened()).toBe(true)
  })

  it('does not publish microphone while joining deafened', () => {
    expect(
      effectiveVoiceJoinPreferences({
        micEnabled: true,
        deafened: true,
      }).micEnabled,
    ).toBe(false)
  })

  it('defaults voice gate and auto balance to conservative settings', () => {
    expect(voicePreferenceStore.getState()).toMatchObject({
      voiceGateEnabled: false,
      voiceGateThreshold: 0.04,
      autoBalanceEnabled: false,
      autoBalanceStrength: 0.5,
    })
  })

  it('clamps voice gate threshold and auto balance strength', () => {
    voicePreferenceStore.setVoiceGateThreshold(2)
    voicePreferenceStore.setAutoBalanceStrength(-1)

    expect(voicePreferenceStore.getState().voiceGateThreshold).toBe(1)
    expect(voicePreferenceStore.getState().autoBalanceStrength).toBe(0)
  })

  it('persists voice gate and auto balance toggles', () => {
    voicePreferenceStore.setVoiceGateEnabled(true)
    voicePreferenceStore.setAutoBalanceEnabled(true)

    expect(voicePreferenceStore.getState().voiceGateEnabled).toBe(true)
    expect(voicePreferenceStore.getState().autoBalanceEnabled).toBe(true)
  })
})
