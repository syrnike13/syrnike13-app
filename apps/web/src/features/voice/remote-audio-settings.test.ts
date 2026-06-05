import { describe, expect, it } from 'vitest'

import { remoteAudioElementVolume } from './remote-audio-settings'

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
})
