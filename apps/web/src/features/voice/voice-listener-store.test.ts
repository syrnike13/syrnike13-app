import { beforeEach, describe, expect, it } from 'vitest'

import { voiceListenerStore } from '#/features/voice/voice-listener-store'

describe('voiceListenerStore mic vs stream channels', () => {
  beforeEach(() => {
    voiceListenerStore.setUserVolume('user-a', 1)
    voiceListenerStore.setUserMuted('user-a', false)
    voiceListenerStore.setStreamVolume('user-a', 1)
    voiceListenerStore.setStreamMuted('user-a', false)
    voiceListenerStore.setUserVolume('user-b', 1)
    voiceListenerStore.setUserMuted('user-b', false)
    voiceListenerStore.setStreamVolume('user-b', 1)
    voiceListenerStore.setStreamMuted('user-b', false)
  })

  it('keeps mic and stream volume independent', () => {
    voiceListenerStore.setUserVolume('user-a', 0.25)
    voiceListenerStore.setStreamVolume('user-a', 0.75)

    expect(voiceListenerStore.getUserVolume('user-a')).toBe(0.25)
    expect(voiceListenerStore.getStreamVolume('user-a')).toBe(0.75)
  })

  it('keeps mic and stream mute independent', () => {
    voiceListenerStore.setUserMuted('user-b', true)
    expect(voiceListenerStore.getUserMuted('user-b')).toBe(true)
    expect(voiceListenerStore.getStreamMuted('user-b')).toBe(false)

    voiceListenerStore.setStreamMuted('user-b', true)
    expect(voiceListenerStore.getUserMuted('user-b')).toBe(true)
    expect(voiceListenerStore.getStreamMuted('user-b')).toBe(true)

    voiceListenerStore.setUserMuted('user-b', false)
    expect(voiceListenerStore.getUserMuted('user-b')).toBe(false)
    expect(voiceListenerStore.getStreamMuted('user-b')).toBe(true)
  })

  it('defaults stream volume to 1 and stream mute to false', () => {
    expect(voiceListenerStore.getStreamVolume('unknown-user')).toBe(1)
    expect(voiceListenerStore.getStreamMuted('unknown-user')).toBe(false)
  })
})
