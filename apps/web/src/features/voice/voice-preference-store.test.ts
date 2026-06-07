import { describe, expect, it, beforeEach } from 'vitest'

import {
  effectiveVoiceJoinPreferences,
  parseNoiseSuppression,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'

describe('voicePreferenceStore', () => {
  beforeEach(() => {
    voicePreferenceStore.setMicEnabled(true)
    voicePreferenceStore.setDeafened(false)
    voicePreferenceStore.setNoiseSuppression('enhanced')
    voicePreferenceStore.setVoiceGateEnabled(true)
    voicePreferenceStore.setVoiceGateAutoThreshold(true)
    voicePreferenceStore.setVoiceGateAutoThreshold(true)
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

  it('defaults to discord-like mic processing settings', () => {
    expect(voicePreferenceStore.getState()).toMatchObject({
      noiseSuppression: 'enhanced',
      voiceGateEnabled: true,
      voiceGateAutoThreshold: true,
      voiceGateThresholdDb: -28,
      voiceGateAutoThreshold: true,
      autoBalanceEnabled: false,
      autoBalanceStrength: 0.5,
    })
  })

  it('clamps voice gate threshold and auto balance strength', () => {
    voicePreferenceStore.setVoiceGateThresholdDb(12)
    voicePreferenceStore.setAutoBalanceStrength(-1)

    expect(voicePreferenceStore.getState().voiceGateThresholdDb).toBe(0)
    expect(voicePreferenceStore.getState().autoBalanceStrength).toBe(0)
  })

  it('migrates legacy browser noise suppression to enhanced', () => {
    expect(parseNoiseSuppression('browser')).toBe('enhanced')
    expect(parseNoiseSuppression(true)).toBe('enhanced')
    expect(parseNoiseSuppression(false)).toBe('disabled')
  })

  it('switches gate threshold to manual when the bar changes', () => {
    voicePreferenceStore.setVoiceGateAutoThreshold(true)
    voicePreferenceStore.setVoiceGateThresholdDb(-18)

    expect(voicePreferenceStore.getState()).toMatchObject({
      voiceGateThresholdDb: -18,
      voiceGateAutoThreshold: false,
    })
  })

  it('persists voice gate and auto balance toggles', () => {
    voicePreferenceStore.setVoiceGateEnabled(true)
    voicePreferenceStore.setAutoBalanceEnabled(true)

    expect(voicePreferenceStore.getState().voiceGateEnabled).toBe(true)
    expect(voicePreferenceStore.getState().autoBalanceEnabled).toBe(true)
  })
})
