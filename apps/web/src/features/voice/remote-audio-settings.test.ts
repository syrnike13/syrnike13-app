// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'

import {
  applyRemoteAudioElement,
  normalizeAutoBalanceStrength,
  remoteAudioElementVolume,
  remoteAutoBalanceGain,
} from './remote-audio-settings'

function createRemoteAudioElement(
  userId: string,
  audioSource: 'mic' | 'stream',
) {
  const element = document.createElement('audio')
  element.dataset.livekit = 'remote'
  element.dataset.livekitUserId = userId
  element.dataset.livekitAudioSource = audioSource
  element.dataset.livekitAudioLevel = '0.2'
  return element
}

describe('remoteAudioElementVolume', () => {
  it('keeps 100% user and output volume at full browser volume', () => {
    expect(remoteAudioElementVolume(1, 1, false)).toBe(1)
  })

  it('caps boost values at the browser audio element maximum', () => {
    expect(remoteAudioElementVolume(3, 1, false)).toBe(1)
    expect(remoteAudioElementVolume(1, 3, false)).toBe(1)
  })

  it('combines attenuation and mute states predictably', () => {
    expect(remoteAudioElementVolume(0.5, 0.5, false)).toBe(0.25)
    expect(remoteAudioElementVolume(1, 1, true)).toBe(0)
  })

  it('applies auto balance gain after base volume', () => {
    expect(remoteAudioElementVolume(0.5, 1, false, 1.5)).toBe(0.75)
    expect(remoteAudioElementVolume(1, 1, false, 2)).toBe(1)
  })
})

describe('remoteAutoBalanceGain', () => {
  it('returns neutral gain when disabled or silent', () => {
    expect(remoteAutoBalanceGain(0.1, 0.5, false)).toBe(1)
    expect(remoteAutoBalanceGain(0, 0.5, true)).toBe(1)
  })

  it('boosts quiet participants and attenuates loud participants', () => {
    expect(remoteAutoBalanceGain(0.1, 1, true)).toBeGreaterThan(1)
    expect(remoteAutoBalanceGain(0.8, 1, true)).toBeLessThan(1)
  })
})

describe('normalizeAutoBalanceStrength', () => {
  it('clamps strength into the unit interval', () => {
    expect(normalizeAutoBalanceStrength(2)).toBe(1)
    expect(normalizeAutoBalanceStrength(-1)).toBe(0)
  })
})

describe('applyRemoteAudioElement', () => {
  beforeEach(() => {
    voiceListenerStore.setUserVolume('remote-user', 1)
    voiceListenerStore.setUserMuted('remote-user', false)
    voiceListenerStore.setStreamVolume('remote-user', 1)
    voiceListenerStore.setStreamMuted('remote-user', false)
    vi.spyOn(voicePreferenceStore, 'getState').mockReturnValue({
      ...voicePreferenceStore.getState(),
      outputVolume: 1,
      autoBalanceEnabled: false,
      autoBalanceStrength: 0.5,
    })
  })

  it('mutes only mic element when user voice is muted', () => {
    voiceListenerStore.setUserMuted('remote-user', true)

    const mic = createRemoteAudioElement('remote-user', 'mic')
    const stream = createRemoteAudioElement('remote-user', 'stream')

    applyRemoteAudioElement(mic, false)
    applyRemoteAudioElement(stream, false)

    expect(mic.muted).toBe(true)
    expect(stream.muted).toBe(false)
  })

  it('mutes only stream element when stream audio is muted', () => {
    voiceListenerStore.setStreamMuted('remote-user', true)

    const mic = createRemoteAudioElement('remote-user', 'mic')
    const stream = createRemoteAudioElement('remote-user', 'stream')

    applyRemoteAudioElement(mic, false)
    applyRemoteAudioElement(stream, false)

    expect(mic.muted).toBe(false)
    expect(stream.muted).toBe(true)
  })

  it('applies independent channel volumes', () => {
    voiceListenerStore.setUserVolume('remote-user', 0.4)
    voiceListenerStore.setStreamVolume('remote-user', 0.8)

    const mic = createRemoteAudioElement('remote-user', 'mic')
    const stream = createRemoteAudioElement('remote-user', 'stream')

    applyRemoteAudioElement(mic, false)
    applyRemoteAudioElement(stream, false)

    expect(mic.volume).toBe(0.4)
    expect(stream.volume).toBe(0.8)
  })
})
