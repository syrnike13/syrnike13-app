// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createRemoteAudioMixer,
  type RemoteAudioMixer,
} from '#/features/voice/remote-audio-mixer'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'

function installMediaStreamMock() {
  let trackId = 0

  class TestMediaStreamTrack {
    enabled = true
    id = `track-${trackId++}`
    kind = 'audio'
    muted = false
    readyState = 'live'

    clone() {
      return new TestMediaStreamTrack()
    }

    stop() {
      this.readyState = 'ended'
    }
  }

  class TestMediaStream {
    constructor(private tracks: MediaStreamTrack[] = []) {}

    getAudioTracks() {
      return this.tracks
    }

    getTracks() {
      return this.tracks
    }
  }

  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: TestMediaStream,
  })
  Object.defineProperty(globalThis, 'MediaStreamTrack', {
    configurable: true,
    value: TestMediaStreamTrack,
  })
  Object.defineProperty(window, 'MediaStream', {
    configurable: true,
    value: TestMediaStream,
  })
  Object.defineProperty(window, 'MediaStreamTrack', {
    configurable: true,
    value: TestMediaStreamTrack,
  })
}

function installAudioContextMock() {
  class TestAudioContext {
    destination = {}
    sinkId: string | undefined

    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() }
    }

    createMediaStreamDestination() {
      return { stream: new MediaStream() }
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
    }

    resume() {
      return Promise.resolve()
    }

    close() {
      return Promise.resolve()
    }

    setSinkId(deviceId: string) {
      this.sinkId = deviceId
      return Promise.resolve()
    }
  }

  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: TestAudioContext,
  })
}

function createTrack() {
  const Track = (
    globalThis as typeof globalThis & {
      MediaStreamTrack: new () => MediaStreamTrack
    }
  ).MediaStreamTrack
  return new Track()
}

describe('RemoteAudioMixer', () => {
  let mixer: RemoteAudioMixer

  beforeEach(() => {
    installMediaStreamMock()
    installAudioContextMock()
    voiceListenerStore.setUserVolume('remote-user', 1)
    voiceListenerStore.setUserMuted('remote-user', false)
    voiceListenerStore.setStreamVolume('remote-user', 1)
    voiceListenerStore.setStreamMuted('remote-user', false)
    voicePreferenceStore.setOutputVolume(1)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    mixer = createRemoteAudioMixer()
  })

  afterEach(() => {
    mixer.dispose()
    Reflect.deleteProperty(window, 'AudioContext')
    Reflect.deleteProperty(window, 'MediaStream')
    Reflect.deleteProperty(window, 'MediaStreamTrack')
    Reflect.deleteProperty(globalThis, 'MediaStream')
    Reflect.deleteProperty(globalThis, 'MediaStreamTrack')
  })

  it('routes remote mic through a gain node and keeps source track live', () => {
    const track = createTrack()

    const added = mixer.addTrack({
      trackId: 'pub-mic',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack: track,
    })
    mixer.applyVolumes(false)

    expect(added).toBe(true)
    expect(track.enabled).toBe(true)
    expect(mixer.debugSnapshot()).toMatchObject([
      {
        trackId: 'pub-mic',
        userId: 'remote-user',
        source: 'mic',
        gain: 1,
        mediaStreamTrack: { enabled: true },
      },
    ])
  })

  it('sets participant volume zero to gain zero', () => {
    const track = createTrack()
    voiceListenerStore.setUserVolume('remote-user', 0)

    mixer.addTrack({
      trackId: 'pub-mic',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack: track,
    })
    mixer.applyVolumes(false)

    expect(mixer.debugSnapshot()[0]).toMatchObject({
      gain: 0,
      mediaStreamTrack: { enabled: true },
    })
  })

  it('applies boosted participant volume without capping at 100%', () => {
    const track = createTrack()
    voiceListenerStore.setUserVolume('remote-user', 1.6)

    mixer.addTrack({
      trackId: 'pub-mic',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack: track,
    })
    mixer.applyVolumes(false)

    expect(mixer.debugSnapshot()[0]?.gain).toBe(1.6)
  })

  it('keeps mic and stream volumes independent', () => {
    voiceListenerStore.setUserVolume('remote-user', 0.4)
    voiceListenerStore.setStreamVolume('remote-user', 0.8)

    mixer.addTrack({
      trackId: 'pub-mic',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack: createTrack(),
    })
    mixer.addTrack({
      trackId: 'pub-stream',
      userId: 'remote-user',
      source: 'stream',
      mediaStreamTrack: createTrack(),
    })
    mixer.applyVolumes(false)

    expect(mixer.debugSnapshot()).toMatchObject([
      { trackId: 'pub-mic', gain: 0.4 },
      { trackId: 'pub-stream', gain: 0.8 },
    ])
  })

  it('restores original track when removed', () => {
    const track = createTrack()
    mixer.addTrack({
      trackId: 'pub-mic',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack: track,
    })

    mixer.removeTrack('pub-mic')

    expect(track.enabled).toBe(true)
    expect(mixer.debugSnapshot()).toEqual([])
  })
})
