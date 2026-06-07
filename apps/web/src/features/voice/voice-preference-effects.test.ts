import { describe, expect, it } from 'vitest'

import { voicePreferenceEffectFlags } from './voice-preference-effects'
import type { VoicePreferenceState } from './voice-preference-store'

const base: VoicePreferenceState = {
  micEnabled: true,
  deafened: false,
  inputVolume: 1,
  outputVolume: 1,
  echoCancellation: true,
  noiseSuppression: 'enhanced',
  voiceGateEnabled: true,
  voiceGateThresholdDb: -28,
  voiceGateAutoThreshold: true,
  autoBalanceEnabled: false,
  autoBalanceStrength: 0.5,
  screenShareQuality: 'low',
  screenShareCodec: 'auto',
  screenShareAudio: true,
  screenShareCaptureMode: 'auto',
}

describe('voicePreferenceEffectFlags', () => {
  it('does not treat voice gate threshold changes as device changes', () => {
    expect(
      voicePreferenceEffectFlags(base, {
        ...base,
        voiceGateThresholdDb: -18,
      }),
    ).toMatchObject({
      devicesChanged: false,
      micProcessingChanged: true,
      remoteAudioChanged: false,
    })
  })

  it('does not treat auto-balance changes as mic processing changes', () => {
    expect(
      voicePreferenceEffectFlags(base, {
        ...base,
        autoBalanceEnabled: true,
      }),
    ).toMatchObject({
      devicesChanged: false,
      micProcessingChanged: false,
      remoteAudioChanged: true,
    })
  })

  it('tracks auto gate threshold changes as mic processing changes', () => {
    expect(
      voicePreferenceEffectFlags(base, {
        ...base,
        voiceGateAutoThreshold: false,
      }),
    ).toMatchObject({
      devicesChanged: false,
      micProcessingChanged: true,
      remoteAudioChanged: false,
    })
  })

  it('tracks input volume changes as mic processing changes', () => {
    expect(
      voicePreferenceEffectFlags(base, {
        ...base,
        inputVolume: 1.5,
      }),
    ).toMatchObject({
      devicesChanged: false,
      micProcessingChanged: true,
      remoteAudioChanged: false,
    })
  })

  it('tracks audio device changes separately', () => {
    expect(
      voicePreferenceEffectFlags(base, {
        ...base,
        preferredAudioOutputDevice: 'headphones',
      }),
    ).toMatchObject({
      devicesChanged: true,
      micProcessingChanged: false,
      remoteAudioChanged: false,
    })
  })
})
