import { describe, expect, it } from 'vitest'

import { voicePreferenceEffectFlags } from './voice-preference-effects'
import type { VoicePreferenceState } from './voice-preference-store'

const base: VoicePreferenceState = {
  micEnabled: true,
  deafened: false,
  outputVolume: 1,
  echoCancellation: true,
  noiseSuppression: 'browser',
  autoGainControl: true,
  voiceGateEnabled: false,
  voiceGateThreshold: 0.04,
  autoBalanceEnabled: false,
  autoBalanceStrength: 0.5,
  screenShareQuality: 'low',
  screenShareCodec: 'vp8',
  screenShareQualityAsk: true,
  screenShareAudio: true,
}

describe('voicePreferenceEffectFlags', () => {
  it('does not treat voice gate threshold changes as device changes', () => {
    expect(
      voicePreferenceEffectFlags(base, {
        ...base,
        voiceGateThreshold: 0.08,
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
