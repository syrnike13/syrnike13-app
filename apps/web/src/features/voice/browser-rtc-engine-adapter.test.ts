// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceLease, VoiceMediaDesiredState } from '@syrnike13/platform'

const livekit = vi.hoisted(() => {
  const rooms: Array<{
    publication: { mute: ReturnType<typeof vi.fn>; unmute: ReturnType<typeof vi.fn> }
    handlers: Map<string, Set<(...args: unknown[]) => void>>
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    switchActiveDevice: ReturnType<typeof vi.fn>
    localParticipant: {
      setMicrophoneEnabled: ReturnType<typeof vi.fn>
      setCameraEnabled: ReturnType<typeof vi.fn>
      setScreenShareEnabled: ReturnType<typeof vi.fn>
      getTrackPublication: ReturnType<typeof vi.fn>
    }
    emit(event: string, ...args: unknown[]): void
  }> = []
  return {
    rooms,
    connectPromise: null as Promise<void> | null,
  }
})

const remoteAudioMixers = vi.hoisted(() => ({
  instances: [] as Array<{
    addTrack: ReturnType<typeof vi.fn>
    removeTrack: ReturnType<typeof vi.fn>
    removeMediaStreamTrack: ReturnType<typeof vi.fn>
    applyVolumes: ReturnType<typeof vi.fn>
    setOutputDevice: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onSpeakingUserIdsChange?: (userIds: ReadonlySet<string>) => void
  }>,
}))

const localSpeakingDetectors = vi.hoisted(() => ({
  instances: [] as Array<{
    setTrack: ReturnType<typeof vi.fn>
    setEnabled: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onSpeakingChange?: (speaking: boolean) => void
  }>,
}))

vi.mock('livekit-client', () => {
  class MockRoom {
    readonly publication = {
      mute: vi.fn(async () => undefined),
      unmute: vi.fn(async () => undefined),
    }
    readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    readonly connect = vi.fn(
      () => livekit.connectPromise ?? Promise.resolve(),
    )
    readonly disconnect = vi.fn(async () => undefined)
    readonly switchActiveDevice = vi.fn(async () => undefined)
    readonly localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => this.publication),
      setCameraEnabled: vi.fn(async () => undefined),
      setScreenShareEnabled: vi.fn(async () => undefined),
      getTrackPublication: vi.fn(() => this.publication),
    }

    constructor() {
      livekit.rooms.push(this)
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.handlers.get(event) ?? new Set()
      listeners.add(listener)
      this.handlers.set(event, listeners)
      return this
    }

    removeAllListeners() {
      this.handlers.clear()
      return this
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.handlers.get(event) ?? []) listener(...args)
    }
  }

  return {
    DisconnectReason: { PARTICIPANT_REMOVED: 1 },
    RoomEvent: {
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      Disconnected: 'disconnected',
      TrackPublished: 'trackPublished',
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
    },
    Track: {
      Kind: { Audio: 'audio' },
      Source: {
        ScreenShare: 'screen_share',
        ScreenShareAudio: 'screen_share_audio',
      },
    },
    Room: MockRoom,
  }
})

vi.mock('./voice-capture', () => ({
  createVoiceRoomOptions: () => ({}),
  screenShareAudioCaptureOptions: (enabled: boolean) => enabled,
  screenShareCombinedPublishOptions: () => ({
    screenShareEncoding: {},
  }),
  voiceAudioProcessingConstraints: () => ({}),
  voiceMicPublishOptions: () => ({}),
}))

vi.mock('./voice-mic-processing', () => ({
  applyMicProcessing: vi.fn(async () => undefined),
}))

vi.mock('./remote-audio-mixer', () => ({
  createRemoteAudioMixer: (options: {
    onSpeakingUserIdsChange?: (userIds: ReadonlySet<string>) => void
  }) => {
    const mixer = {
      addTrack: vi.fn(() => true),
      removeTrack: vi.fn(),
      removeMediaStreamTrack: vi.fn(),
      applyVolumes: vi.fn(async () => undefined),
      setOutputDevice: vi.fn(async () => undefined),
      dispose: vi.fn(),
      onSpeakingUserIdsChange: options.onSpeakingUserIdsChange,
    }
    remoteAudioMixers.instances.push(mixer)
    return mixer
  },
}))

vi.mock('./local-speaking-detector', () => ({
  createLocalSpeakingDetector: (options: {
    onSpeakingChange: (speaking: boolean) => void
  }) => {
    const detector = {
      setTrack: vi.fn(),
      setEnabled: vi.fn(),
      dispose: vi.fn(),
      onSpeakingChange: options.onSpeakingChange,
    }
    localSpeakingDetectors.instances.push(detector)
    return detector
  },
}))

import { BrowserRtcEngineAdapter } from './browser-rtc-engine-adapter'
import { applyMicProcessing } from './voice-mic-processing'

const lease: VoiceLease = {
  channelId: 'A',
  rtcEngine: 'web',
  clientInstanceId: 'web-tab',
  operationId: 'op-a',
  connectionEpoch: 'epoch-a',
  authorityVersion: 1,
  credential: {
    url: 'wss://voice.invalid',
    token: 'token-a',
    participantIdentity: 'identity-a',
  },
}

function desired(
  patch: Partial<VoiceMediaDesiredState> = {},
): VoiceMediaDesiredState {
  return {
    userMuted: false,
    userDeafened: false,
    serverMuted: false,
    serverDeafened: false,
    systemPrivacyMuted: false,
    monitoringMuted: false,
    inputMode: 'voice_activity',
    pushToTalkHeld: false,
    effectiveMuted: false,
    bypassSystemAudioInputProcessing: true,
    automaticGainControl: false,
    noiseSuppression: true,
    echoCancellation: true,
    inputVolume: 1,
    voiceGateEnabled: true,
    voiceGateThresholdDb: -28,
    voiceGateAutoThreshold: true,
    outputVolume: 1,
    cameraEnabled: false,
    screenEnabled: false,
    screenAudioEnabled: false,
    ...patch,
  }
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('BrowserRtcEngineAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    livekit.rooms.length = 0
    livekit.connectPromise = null
    remoteAudioMixers.instances.length = 0
    localSpeakingDetectors.instances.length = 0
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })

  it('keeps one Room and does not restart camera or screen for a mute update', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const initial = desired({
      cameraEnabled: true,
      screenEnabled: true,
      screenAudioEnabled: true,
    })
    await adapter.connect(lease, initial, new AbortController().signal)
    const room = livekit.rooms[0]
    await waitUntil(
      () => room.localParticipant.setScreenShareEnabled.mock.calls.length === 1,
    )

    adapter.updateDesiredMedia({
      ...initial,
      userMuted: true,
      effectiveMuted: true,
    })
    await waitUntil(() => room.publication.mute.mock.calls.length === 1)

    expect(livekit.rooms).toHaveLength(1)
    expect(room.connect).toHaveBeenCalledTimes(1)
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledTimes(1)
    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenCalledTimes(1)
    expect(room.disconnect).not.toHaveBeenCalled()
    await adapter.dispose()
  })

  it('keeps newly published remote screen media unsubscribed until requested', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    const screenVideo = {
      source: 'screen_share',
      isSubscribed: true,
      setSubscribed: vi.fn(),
    }
    const screenAudio = {
      source: 'screen_share_audio',
      isSubscribed: true,
      setSubscribed: vi.fn(),
    }
    const microphone = {
      source: 'microphone',
      isSubscribed: true,
      setSubscribed: vi.fn(),
    }

    room.emit('trackPublished', screenVideo)
    room.emit('trackPublished', screenAudio)
    room.emit('trackPublished', microphone)

    expect(screenVideo.setSubscribed).toHaveBeenCalledWith(false)
    expect(screenAudio.setSubscribed).toHaveBeenCalledWith(false)
    expect(microphone.setSubscribed).not.toHaveBeenCalled()
    await adapter.dispose()
  })

  it('waits for signaling before publishing desired media', async () => {
    let resolveConnect!: () => void
    livekit.connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve
    })
    const adapter = new BrowserRtcEngineAdapter()
    const connecting = adapter.connect(
      lease,
      desired({ screenEnabled: false }),
      new AbortController().signal,
    )
    const room = livekit.rooms[0]

    adapter.updateDesiredMedia(
      desired({
        cameraEnabled: true,
        screenEnabled: true,
        screenAudioEnabled: true,
      }),
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled()
    expect(room.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled()

    resolveConnect()
    await connecting
    await waitUntil(
      () =>
        room.localParticipant.setCameraEnabled.mock.calls.length === 1 &&
        room.localParticipant.setScreenShareEnabled.mock.calls.length === 1,
    )

    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      expect.any(Object),
    )
    await adapter.dispose()
  })

  it('queues media changes until signaling recovers', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const initial = desired({ screenEnabled: false })
    await adapter.connect(lease, initial, new AbortController().signal)
    const room = livekit.rooms[0]
    await waitUntil(
      () =>
        room.localParticipant.setScreenShareEnabled.mock.calls.length === 1 &&
        remoteAudioMixers.instances[0].setOutputDevice.mock.calls.length === 1,
    )

    room.emit('reconnecting')
    adapter.updateDesiredMedia({
      ...initial,
      screenEnabled: true,
      screenAudioEnabled: true,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenCalledTimes(1)

    room.emit('reconnected')
    await waitUntil(
      () => room.localParticipant.setScreenShareEnabled.mock.calls.length === 2,
    )
    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(
      true,
      expect.any(Object),
      expect.any(Object),
    )
    await adapter.dispose()
  })

  it('does not advance an in-flight media reconcile while signaling is reconnecting', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const initial = desired({ screenEnabled: false })
    await adapter.connect(lease, initial, new AbortController().signal)
    const room = livekit.rooms[0]
    await waitUntil(
      () => room.localParticipant.setScreenShareEnabled.mock.calls.length === 1,
    )

    let finishScreenStart!: () => void
    room.localParticipant.setScreenShareEnabled.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishScreenStart = resolve
      }),
    )
    adapter.updateDesiredMedia({
      ...initial,
      screenEnabled: true,
      screenAudioEnabled: true,
    })
    await waitUntil(
      () => room.localParticipant.setScreenShareEnabled.mock.calls.length === 2,
    )

    room.emit('reconnecting')
    adapter.updateDesiredMedia(initial)
    finishScreenStart()
    await Promise.resolve()
    await Promise.resolve()

    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenCalledTimes(2)

    room.emit('reconnected')
    await waitUntil(
      () => room.localParticipant.setScreenShareEnabled.mock.calls.length === 3,
    )
    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(
      false,
      expect.any(Object),
      expect.any(Object),
    )
    await adapter.dispose()
  })

  it('does not block camera, screen, or output while microphone permission is pending', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const initial = desired({
      cameraEnabled: true,
      screenEnabled: true,
      screenAudioEnabled: true,
    })
    const connecting = adapter.connect(
      lease,
      initial,
      new AbortController().signal,
    )
    const room = livekit.rooms[0]
    room.localParticipant.setMicrophoneEnabled.mockReturnValue(
      new Promise(() => undefined),
    )

    await connecting
    await waitUntil(
      () =>
        room.localParticipant.setCameraEnabled.mock.calls.length === 1 &&
        room.localParticipant.setScreenShareEnabled.mock.calls.length === 1 &&
        remoteAudioMixers.instances[0].setOutputDevice.mock.calls.length === 1,
    )

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1)
    await adapter.dispose()
  })

  it('switches microphone devices in place without republishing or reconnecting', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    await waitUntil(
      () => room.localParticipant.setMicrophoneEnabled.mock.calls.length === 1,
    )

    adapter.updateDesiredMedia(desired({ microphoneDeviceId: 'mic-b' }))
    await waitUntil(() =>
      room.switchActiveDevice.mock.calls.some(
        ([kind, id]) => kind === 'audioinput' && id === 'mic-b',
      ),
    )

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1)
    expect(room.connect).toHaveBeenCalledTimes(1)
    await adapter.dispose()
  })

  it('applies DSP changes without muting, republishing, or reconnecting', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    await waitUntil(() => vi.mocked(applyMicProcessing).mock.calls.length === 1)

    adapter.updateDesiredMedia(desired({ inputVolume: 1.5 }))
    await waitUntil(() => vi.mocked(applyMicProcessing).mock.calls.length === 2)

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1)
    expect(room.publication.mute).not.toHaveBeenCalled()
    expect(room.publication.unmute).toHaveBeenCalledTimes(1)
    expect(room.connect).toHaveBeenCalledTimes(1)
    await adapter.dispose()
  })

  it('reports a track failure independently and keeps the Room connected', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    room.localParticipant.setCameraEnabled.mockRejectedValueOnce(
      new Error('camera denied'),
    )

    adapter.updateDesiredMedia(desired({ cameraEnabled: true }))
    await waitUntil(() =>
      events.some(
        (event) =>
          (event as { type?: string; kind?: string; media?: { state?: string } })
            .type === 'mediaState' &&
          (event as { kind?: string }).kind === 'camera' &&
          (event as { media?: { state?: string } }).media?.state === 'failed',
      ),
    )

    expect(room.connect).toHaveBeenCalledTimes(1)
    expect(room.disconnect).not.toHaveBeenCalled()
    expect(
      events.some((event) => (event as { type?: string }).type === 'terminalFailure'),
    ).toBe(false)
    await adapter.dispose()
  })

  it('turns an unexpected Room disconnect into one terminal voice failure', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(lease, desired(), new AbortController().signal)

    livekit.rooms[0].emit('disconnected', 0)

    expect(events).toContainEqual({
      type: 'terminalFailure',
      operationId: 'op-a',
      connectionEpoch: 'epoch-a',
      failure: {
        code: 'browser_rtc_disconnected',
        message: 'Browser voice connection ended',
        retryable: true,
        stage: 'livekit_room',
      },
    })
    await adapter.dispose()
  })

  it('keeps exactly one silent LiveKit decoder sink per remote audio track', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    const mixer = remoteAudioMixers.instances[0]
    const element = document.createElement('audio')
    const track = {
      kind: 'audio',
      mediaStreamTrack: { id: 'remote-track' },
      attach: vi.fn(() => element),
      detach: vi.fn((target?: HTMLAudioElement) =>
        target ? target : ([] as HTMLAudioElement[]),
      ),
    }
    const publication = {
      trackSid: 'TR_remote',
      source: 'microphone',
    }
    const participant = { identity: 'remote-user' }

    room.emit('trackSubscribed', track, publication, participant)

    expect(track.attach).toHaveBeenCalledTimes(1)
    expect(element.dataset.syrnikeRemoteAudioDecoder).toBe('TR_remote')
    expect(element.autoplay).toBe(true)
    expect(element.muted).toBe(true)
    expect(element.volume).toBe(0)
    expect(element.isConnected).toBe(true)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    expect(mixer.addTrack).toHaveBeenCalledWith({
      trackId: 'TR_remote',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack: track.mediaStreamTrack,
    })

    room.emit('trackUnsubscribed', track, publication, participant)

    expect(track.detach).toHaveBeenLastCalledWith(element)
    expect(mixer.removeTrack).toHaveBeenCalledWith('TR_remote')
    expect(element.srcObject).toBeNull()
    expect(element.isConnected).toBe(false)
    await adapter.dispose()
  })

  it('uses local audio activity instead of LiveKit active-speaker events', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    const mixer = remoteAudioMixers.instances[0]

    room.emit('activeSpeakersChanged', [{ identity: 'server-user' }])
    expect(
      events.some((event) => (event as { type?: string }).type === 'speakingChanged'),
    ).toBe(false)

    mixer.onSpeakingUserIdsChange?.(new Set(['remote-user']))
    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: ['remote-user'],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })
    await adapter.dispose()
  })

  it('publishes self activity from the processed local microphone track', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(lease, desired(), new AbortController().signal)
    const detector = localSpeakingDetectors.instances[0]
    detector.onSpeakingChange?.(true)

    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: ['identity-a'],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })
    await adapter.dispose()
    expect(detector.dispose).toHaveBeenCalledTimes(1)
  })

  it('replaces a duplicate subscription without leaking decoder elements', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    const firstElement = document.createElement('audio')
    const secondElement = document.createElement('audio')
    const firstTrack = {
      kind: 'audio',
      mediaStreamTrack: { id: 'remote-track-a' },
      attach: vi.fn(() => firstElement),
      detach: vi.fn((target?: HTMLAudioElement) =>
        target ? target : ([] as HTMLAudioElement[]),
      ),
    }
    const secondTrack = {
      kind: 'audio',
      mediaStreamTrack: { id: 'remote-track-b' },
      attach: vi.fn(() => secondElement),
      detach: vi.fn((target?: HTMLAudioElement) =>
        target ? target : ([] as HTMLAudioElement[]),
      ),
    }
    const publication = {
      trackSid: 'TR_remote',
      source: 'microphone',
    }
    const participant = { identity: 'remote-user' }

    room.emit('trackSubscribed', firstTrack, publication, participant)
    room.emit('trackSubscribed', secondTrack, publication, participant)
    room.emit('trackUnsubscribed', firstTrack, publication, participant)

    expect(firstTrack.detach).toHaveBeenLastCalledWith(firstElement)
    expect(firstElement.isConnected).toBe(false)
    expect(secondElement.isConnected).toBe(true)
    expect(
      document.querySelectorAll('[data-syrnike-remote-audio-decoder="TR_remote"]'),
    ).toHaveLength(1)

    await adapter.dispose()
    expect(secondTrack.detach).toHaveBeenLastCalledWith(secondElement)
    expect(secondElement.isConnected).toBe(false)
  })

  it('does not attach a decoder sink when the remote media track is missing', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    const track = {
      kind: 'audio',
      attach: vi.fn(() => document.createElement('audio')),
      detach: vi.fn(() => [] as HTMLAudioElement[]),
    }

    room.emit(
      'trackSubscribed',
      track,
      { trackSid: 'TR_missing', source: 'microphone' },
      { identity: 'remote-user' },
    )

    expect(track.attach).not.toHaveBeenCalled()
    expect(
      document.querySelector('[data-syrnike-remote-audio-decoder="TR_missing"]'),
    ).toBeNull()
    await adapter.dispose()
  })

  it('routes screen-share audio through the independent stream volume channel', async () => {
    const adapter = new BrowserRtcEngineAdapter()
    await adapter.connect(lease, desired(), new AbortController().signal)
    const room = livekit.rooms[0]
    const mixer = remoteAudioMixers.instances[0]
    const element = document.createElement('audio')
    const track = {
      kind: 'audio',
      mediaStreamTrack: { id: 'remote-screen-audio' },
      attach: vi.fn(() => element),
      detach: vi.fn((target?: HTMLAudioElement) =>
        target ? target : ([] as HTMLAudioElement[]),
      ),
    }

    room.emit(
      'trackSubscribed',
      track,
      { trackSid: 'TR_screen_audio', source: 'screen_share_audio' },
      { identity: 'remote-user' },
    )

    expect(mixer.addTrack).toHaveBeenCalledWith({
      trackId: 'TR_screen_audio',
      userId: 'remote-user',
      source: 'stream',
      mediaStreamTrack: track.mediaStreamTrack,
    })
    await adapter.dispose()
  })

  it('cleans a subscribed decoder sink when connection is aborted', async () => {
    livekit.connectPromise = new Promise(() => undefined)
    const adapter = new BrowserRtcEngineAdapter()
    const controller = new AbortController()
    const connecting = adapter.connect(lease, desired(), controller.signal)
    const room = livekit.rooms[0]
    const mixer = remoteAudioMixers.instances[0]
    const element = document.createElement('audio')
    const track = {
      kind: 'audio',
      mediaStreamTrack: { id: 'remote-during-connect' },
      attach: vi.fn(() => element),
      detach: vi.fn((target?: HTMLAudioElement) =>
        target ? target : ([] as HTMLAudioElement[]),
      ),
    }

    room.emit(
      'trackSubscribed',
      track,
      { trackSid: 'TR_during_connect', source: 'microphone' },
      { identity: 'remote-user' },
    )
    expect(element.isConnected).toBe(true)

    controller.abort()
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' })

    expect(track.detach).toHaveBeenLastCalledWith(element)
    expect(element.isConnected).toBe(false)
    expect(mixer.dispose).toHaveBeenCalledTimes(1)
  })
})
