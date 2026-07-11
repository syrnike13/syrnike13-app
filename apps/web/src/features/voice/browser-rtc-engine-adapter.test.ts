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
    }
    emit(event: string, ...args: unknown[]): void
  }> = []
  return { rooms }
})

vi.mock('livekit-client', () => {
  class MockRoom {
    readonly publication = {
      mute: vi.fn(async () => undefined),
      unmute: vi.fn(async () => undefined),
    }
    readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    readonly connect = vi.fn(async () => undefined)
    readonly disconnect = vi.fn(async () => undefined)
    readonly switchActiveDevice = vi.fn(async () => undefined)
    readonly localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => this.publication),
      setCameraEnabled: vi.fn(async () => undefined),
      setScreenShareEnabled: vi.fn(async () => undefined),
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
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
    },
    Track: {
      Kind: { Audio: 'audio' },
      Source: { ScreenShareAudio: 'screen_share_audio' },
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
    vi.clearAllMocks()
    livekit.rooms.length = 0
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
})
