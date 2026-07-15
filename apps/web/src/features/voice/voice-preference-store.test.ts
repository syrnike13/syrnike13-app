import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  defaultScreenShareQuality,
  effectiveVoiceJoinPreferences,
  loadVoicePreferenceState,
  parseScreenShareCaptureMode,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'

describe('voicePreferenceStore', () => {
  const browserStorage = new Map<string, string>()

  beforeEach(() => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      clear: () => browserStorage.clear(),
      getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => browserStorage.set(key, value),
    })
    localStorage.clear()
    voicePreferenceStore.setMicEnabled(true)
    voicePreferenceStore.setDeafened(false)
    voicePreferenceStore.setVoiceGateEnabled(true)
    voicePreferenceStore.setVoiceGateAutoThreshold(true)
    voicePreferenceStore.setBypassSystemAudioInputProcessing(true)
    voicePreferenceStore.setAutomaticGainControl(true)
    voicePreferenceStore.setNoiseSuppression(true)
    voicePreferenceStore.setEchoCancellation(false)
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
      voiceGateEnabled: true,
      voiceGateAutoThreshold: true,
      voiceGateThresholdDb: -28,
      bypassSystemAudioInputProcessing: true,
      automaticGainControl: true,
      noiseSuppression: true,
      echoCancellation: false,
    })
  })

  it('migrates legacy browser preferences once and persists the marker', () => {
    localStorage.setItem(
      'syrnike13-voice-preferences',
      JSON.stringify({
        preferredAudioInputDevice: 'legacy-mic',
        inputVolume: 0.42,
        voiceGateEnabled: false,
        echoCancellation: true,
        automaticGainControl: false,
      }),
    )

    expect(loadVoicePreferenceState()).toMatchObject({
      preferredAudioInputDevice: 'legacy-mic',
      inputVolume: 0.42,
      voiceGateEnabled: false,
      echoCancellation: false,
      automaticGainControl: true,
    })
    expect(
      JSON.parse(localStorage.getItem('syrnike13-voice-preferences') ?? '{}'),
    ).toMatchObject({
      version: 2,
      preferredAudioInputDevice: 'legacy-mic',
      inputVolume: 0.42,
      voiceGateEnabled: false,
      echoCancellation: false,
      automaticGainControl: true,
    })
  })

  it('preserves explicit microphone values in current browser preferences', () => {
    localStorage.setItem(
      'syrnike13-voice-preferences',
      JSON.stringify({
        version: 2,
        echoCancellation: true,
        automaticGainControl: false,
      }),
    )

    expect(loadVoicePreferenceState()).toMatchObject({
      echoCancellation: true,
      automaticGainControl: false,
    })
  })

  it('clamps voice gate threshold', () => {
    voicePreferenceStore.setVoiceGateThresholdDb(12)

    expect(voicePreferenceStore.getState().voiceGateThresholdDb).toBe(0)
  })

  it('does not preserve legacy browser screen share capture mode', () => {
    expect(parseScreenShareCaptureMode('browser')).toBe('auto')
  })

  it('defaults Windows desktop screen share quality to 1080p 60fps', () => {
    const previousWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        syrnikeDesktop: {
          platform: { os: 'win32' },
        },
      },
    })

    try {
      expect(defaultScreenShareQuality()).toBe('high60')
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      })
    }
  })

  it('switches gate threshold to manual when the bar changes', () => {
    voicePreferenceStore.setVoiceGateAutoThreshold(true)
    voicePreferenceStore.setVoiceGateThresholdDb(-18)

    expect(voicePreferenceStore.getState()).toMatchObject({
      voiceGateThresholdDb: -18,
      voiceGateAutoThreshold: false,
    })
  })

  it('persists voice gate toggle', () => {
    voicePreferenceStore.setVoiceGateEnabled(true)

    expect(voicePreferenceStore.getState().voiceGateEnabled).toBe(true)
  })

  it('persists separate microphone cleanup toggles', () => {
    voicePreferenceStore.setBypassSystemAudioInputProcessing(false)
    voicePreferenceStore.setAutomaticGainControl(false)
    voicePreferenceStore.setNoiseSuppression(false)
    voicePreferenceStore.setEchoCancellation(true)

    expect(voicePreferenceStore.getState()).toMatchObject({
      bypassSystemAudioInputProcessing: false,
      automaticGainControl: false,
      noiseSuppression: false,
      echoCancellation: true,
    })
  })
})
