import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  defaultScreenShareQuality,
  effectiveVoiceJoinPreferences,
  loadVoicePreferenceState,
  parseScreenShareCaptureMode,
  voicePreferenceStore,
  normalizeVoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import {
  NATIVE_SCREEN_SHARE_PROFILES,
  nativeScreenShareProfileSettings,
} from '#/features/voice/voice-preference-types'

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
    voicePreferenceStore.setCameraProfile('hd720p30')
    voicePreferenceStore.setNativeScreenShareProfile('720p30')
  })

  it('persists native screen profiles separately from browser quality', () => {
    voicePreferenceStore.setScreenShareQuality('text')
    voicePreferenceStore.setNativeScreenShareProfile('1080p60')
    expect(loadVoicePreferenceState()).toMatchObject({
      screenShareQuality: 'text',
      nativeScreenShareProfile: '1080p60',
    })
    expect(normalizeVoicePreferenceState({}).nativeScreenShareProfile).toBe('720p30')
    expect(normalizeVoicePreferenceState({
      nativeScreenShareProfile: 'invalid',
    }).nativeScreenShareProfile).toBe('720p30')
  })

  it('maps native screen choices to the runtime supported preset contract', () => {
    expect(NATIVE_SCREEN_SHARE_PROFILES.map(nativeScreenShareProfileSettings)).toEqual([
      { width: 960, height: 540, fps: 30, bitrate: 625_000, audioBitrate: 128_000 },
      { width: 1_280, height: 720, fps: 30, bitrate: 2_000_000, audioBitrate: 128_000 },
      { width: 1_280, height: 720, fps: 60, bitrate: 4_000_000, audioBitrate: 128_000 },
      { width: 1_920, height: 1_080, fps: 30, bitrate: 6_000_000, audioBitrate: 128_000 },
      { width: 1_920, height: 1_080, fps: 60, bitrate: 8_000_000, audioBitrate: 128_000 },
    ])
  })

  it('persists camera profiles and defaults older or invalid preferences to 720p', () => {
    voicePreferenceStore.setCameraProfile('hd1080p30')
    expect(loadVoicePreferenceState().cameraProfile).toBe('hd1080p30')
    expect(normalizeVoicePreferenceState({}).cameraProfile).toBe('hd720p30')
    expect(normalizeVoicePreferenceState({ cameraProfile: 'invalid' }).cameraProfile).toBe('hd720p30')
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
