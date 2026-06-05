import { describe, expect, it } from 'vitest'

import {
  normalizeAutoBalanceStrength,
  remoteAudioElementVolume,
  remoteAutoBalanceGain,
} from './remote-audio-settings'

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
