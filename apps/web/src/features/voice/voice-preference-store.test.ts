import { describe, expect, it, beforeEach } from 'vitest'

import {
  effectiveVoiceJoinPreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'

describe('voicePreferenceStore', () => {
  beforeEach(() => {
    voicePreferenceStore.setMicEnabled(true)
    voicePreferenceStore.setDeafened(false)
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
})
