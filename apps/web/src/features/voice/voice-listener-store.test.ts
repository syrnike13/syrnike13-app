// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  streamVolumeFromPercent,
  streamVolumeToPercent,
  voiceListenerStore,
} from '#/features/voice/voice-listener-store'

describe('voiceListenerStore mic vs stream channels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

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

  it('persists a dragged slider once it settles', () => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(1_000)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    for (let step = 1; step <= 10; step += 1) {
      voiceListenerStore.setStreamVolume('user-a', step / 10)
    }
    expect(voiceListenerStore.getStreamVolume('user-a')).toBe(1)
    expect(setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(setItem).toHaveBeenCalledOnce()
    expect(setItem.mock.calls[0]?.[1]).toContain('"user-a":1')
  })

  it('caps stream volume at 100% and keeps mic boost', () => {
    voiceListenerStore.setStreamVolume('user-a', 2)
    voiceListenerStore.setUserVolume('user-a', 2)

    expect(voiceListenerStore.getStreamVolume('user-a')).toBe(1)
    expect(voiceListenerStore.getUserVolume('user-a')).toBe(2)
    expect(voiceListenerStore.snapshot(1).streamVolumes['user-a']).toBe(1)
  })

  it('round-trips stream volume through slider percents', () => {
    expect(streamVolumeToPercent(1)).toBe(100)
    expect(streamVolumeToPercent(0.35)).toBe(35)
    expect(streamVolumeToPercent(4)).toBe(100)
    expect(streamVolumeFromPercent(35)).toBe(0.35)
    expect(streamVolumeFromPercent(100)).toBe(1)
    expect(streamVolumeFromPercent(140)).toBe(1)
  })

  it('defaults stream volume to 1 and stream mute to false', () => {
    expect(voiceListenerStore.getStreamVolume('unknown-user')).toBe(1)
    expect(voiceListenerStore.getStreamMuted('unknown-user')).toBe(false)
  })
})
