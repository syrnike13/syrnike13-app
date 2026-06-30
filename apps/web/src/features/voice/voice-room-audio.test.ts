/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from 'livekit-client'

import {
  applyRemoteAudio,
  attachRoomAudio,
  audioSourceFromPublication,
  cleanupRemoteAudioTrackSubscription,
  cleanupVoiceRoomAudio,
  localMicMediaStreamTrack,
  playRemoteAudioTrack,
  remoteAudioTrackId,
  type AudioTrackWithMedia,
  type LocalAudioTrackWithProcessor,
} from '#/features/voice/voice-room-audio'

function createRoomHarness() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    room: {
      numParticipants: 3,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
      removeAllListeners: vi.fn(),
      remoteParticipants: new Map(),
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args)
      }
    },
  }
}

function createAttachRoomAudioDeps(overrides: Partial<Parameters<typeof attachRoomAudio>[1]> = {}) {
  return {
    currentUserId: 'local-user',
    getRemoteAudioMixer: () => null,
    getDeafened: () => false,
    getNativeScreenState: () => ({ status: 'idle' }),
    getStoppedNativeScreenIdentity: () => null,
    getCurrentRoom: () => null,
    getTargetChannelId: () => 'voice-a',
    markConnected: vi.fn(),
    setParticipantCount: vi.fn(),
    syncRoomParticipants: vi.fn(),
    runVoiceRecovery: vi.fn(),
    syncLocalSpeakingTrack: vi.fn(),
    applyRemoteScreenParticipantSubscription: vi.fn(() => true),
    syncMicFromRoom: vi.fn(),
    abortJoinAttempt: vi.fn(),
    onNativeScreenPublicationLost: vi.fn(),
    onUnexpectedRoomDisconnect: vi.fn(),
    playUiSound: vi.fn(),
    ...overrides,
  }
}

describe('voice room audio helpers', () => {
  it('maps remote audio publications to mixer source names', () => {
    expect(
      audioSourceFromPublication({
        source: Track.Source.ScreenShareAudio,
      } as RemoteTrackPublication),
    ).toBe('stream')

    expect(
      audioSourceFromPublication({
        source: Track.Source.Microphone,
      } as RemoteTrackPublication),
    ).toBe('mic')
  })

  it('uses processed local mic tracks when the Syrnike processor is attached', () => {
    const raw = { id: 'raw-track' } as MediaStreamTrack
    const processed = { id: 'processed-track' } as MediaStreamTrack
    const track = {
      mediaStreamTrack: raw,
      getProcessor: () => ({
        name: 'syrnike-mic-processor',
        processedTrack: processed,
      }),
    } as LocalAudioTrackWithProcessor

    expect(localMicMediaStreamTrack(track)).toBe(processed)
  })

  it('falls back to the raw local mic media stream track', () => {
    const raw = { id: 'raw-track' } as MediaStreamTrack

    expect(
      localMicMediaStreamTrack({
        mediaStreamTrack: raw,
      } as LocalAudioTrackWithProcessor),
    ).toBe(raw)
  })

  it('chooses stable remote audio track ids before falling back to random UUID', () => {
    expect(
      remoteAudioTrackId({} as Track, {
        trackSid: 'publication-track-sid',
      } as RemoteTrackPublication),
    ).toBe('publication-track-sid')

    expect(
      remoteAudioTrackId({ sid: 'track-sid' } as AudioTrackWithMedia, {
        trackSid: undefined,
      } as unknown as RemoteTrackPublication),
    ).toBe('track-sid')

    expect(
      remoteAudioTrackId(
        {
          mediaStreamTrack: { id: 'media-track-id' } as MediaStreamTrack,
        } as AudioTrackWithMedia,
        { trackSid: undefined } as unknown as RemoteTrackPublication,
      ),
    ).toBe('media-track-id')

    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000000',
    )
    expect(
      remoteAudioTrackId({} as Track, {
        trackSid: undefined,
      } as unknown as RemoteTrackPublication),
    ).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('cleans mixer, local detector, speaking state, and hidden source elements', () => {
    const sourceElement = document.createElement('audio')
    sourceElement.dataset.syrnikeRemoteAudioMixer = 'source'
    document.body.appendChild(sourceElement)
    const outputElement = document.createElement('audio')
    outputElement.dataset.syrnikeRemoteAudioMixer = 'output'
    document.body.appendChild(outputElement)
    const mixer = { clear: vi.fn() }
    const detector = { clear: vi.fn() }
    const setSelfSpeaking = vi.fn()

    cleanupVoiceRoomAudio({
      getRemoteAudioMixer: () => mixer,
      getLocalSpeakingDetector: () => detector,
      setSelfSpeaking,
    })

    expect(mixer.clear).toHaveBeenCalled()
    expect(detector.clear).toHaveBeenCalled()
    expect(setSelfSpeaking).toHaveBeenCalledWith(false)
    expect(document.body.contains(sourceElement)).toBe(false)
    expect(document.body.contains(outputElement)).toBe(true)
  })

  it('applies remote audio volumes using the current deafened state', () => {
    const mixer = { applyVolumes: vi.fn() }

    applyRemoteAudio({
      getRemoteAudioMixer: () => mixer,
      isDeafened: () => true,
    })

    expect(mixer.applyVolumes).toHaveBeenCalledWith(true)
  })

  it('attaches remote audio tracks as hidden mixer sources', () => {
    const detachedElement = document.createElement('audio')
    document.body.appendChild(detachedElement)
    const mediaStreamTrack = { id: 'media-track-id' } as MediaStreamTrack
    const sourceElement = document.createElement('audio')
    sourceElement.play = vi.fn(() => Promise.resolve())
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack,
      detach: vi.fn(() => [detachedElement]),
      attach: vi.fn(() => sourceElement),
    } as unknown as Track
    const publication = {
      source: Track.Source.Microphone,
      trackSid: 'publication-track-sid',
    } as RemoteTrackPublication
    const participant = {
      identity: 'remote-user',
    } as RemoteParticipant
    const mixer = { addTrack: vi.fn(() => true) }
    const applyRemoteAudio = vi.fn()

    playRemoteAudioTrack(track, publication, participant, {
      currentUserId: 'local-user',
      getRemoteAudioMixer: () => mixer,
      applyRemoteAudio,
    })

    const attachedElement = document.querySelector(
      'audio[data-syrnike-remote-audio-mixer="source"]',
    ) as HTMLAudioElement | null
    expect(document.body.contains(detachedElement)).toBe(false)
    expect(attachedElement).not.toBeNull()
    expect(attachedElement?.muted).toBe(true)
    expect(attachedElement?.volume).toBe(0)
    expect(mixer.addTrack).toHaveBeenCalledWith({
      trackId: 'publication-track-sid',
      userId: 'remote-user',
      source: 'mic',
      mediaStreamTrack,
    })
    expect(applyRemoteAudio).toHaveBeenCalled()
  })

  it('cleans remote audio subscriptions from mixer and DOM', () => {
    const detachedElement = document.createElement('audio')
    document.body.appendChild(detachedElement)
    const mediaStreamTrack = { id: 'media-track-id' } as MediaStreamTrack
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack,
      detach: vi.fn(() => [detachedElement]),
    } as unknown as Track
    const publication = {
      trackSid: 'publication-track-sid',
    } as RemoteTrackPublication
    const mixer = {
      removeTrack: vi.fn(),
      removeMediaStreamTrack: vi.fn(),
    }

    cleanupRemoteAudioTrackSubscription(track, publication, {
      getRemoteAudioMixer: () => mixer,
    })

    expect(mixer.removeTrack).toHaveBeenCalledWith('publication-track-sid')
    expect(mixer.removeMediaStreamTrack).toHaveBeenCalledWith(mediaStreamTrack)
    expect(document.body.contains(detachedElement)).toBe(false)
  })

  it('marks the room connected and syncs participants when LiveKit connects', () => {
    const { room, emit } = createRoomHarness()
    const markConnected = vi.fn()
    const setParticipantCount = vi.fn()
    const syncRoomParticipants = vi.fn()
    const runVoiceRecovery = vi.fn()
    const playUiSound = vi.fn()

    attachRoomAudio(room as never, {
      currentUserId: 'local-user',
      getRemoteAudioMixer: () => null,
      getDeafened: () => false,
      getNativeScreenState: () => ({ status: 'idle', visibleInRoom: false }),
      getStoppedNativeScreenIdentity: () => null,
      getCurrentRoom: () => room as never,
      getTargetChannelId: () => 'voice-a',
      markConnected,
      setParticipantCount,
      syncRoomParticipants,
      runVoiceRecovery,
      syncLocalSpeakingTrack: vi.fn(),
      applyRemoteScreenParticipantSubscription: vi.fn(() => true),
      syncMicFromRoom: vi.fn(),
      abortJoinAttempt: vi.fn(),
      onNativeScreenPublicationLost: vi.fn(),
      onUnexpectedRoomDisconnect: vi.fn(),
      playUiSound,
    })

    emit('connected')

    expect(markConnected).toHaveBeenCalled()
    expect(playUiSound).toHaveBeenCalledWith('voice.user_join')
    expect(setParticipantCount).toHaveBeenCalledWith(3)
    expect(syncRoomParticipants).toHaveBeenCalled()
    expect(runVoiceRecovery).toHaveBeenCalledWith('participants_changed')
  })

  it('forwards active unexpected room disconnects to recovery wiring', () => {
    const { room, emit } = createRoomHarness()
    const onUnexpectedRoomDisconnect = vi.fn()

    attachRoomAudio(room as never, createAttachRoomAudioDeps({
      getCurrentRoom: () => room as never,
      onUnexpectedRoomDisconnect,
    }))

    emit(RoomEvent.Disconnected)

    expect(onUnexpectedRoomDisconnect).toHaveBeenCalledWith('voice-a')
  })

  it('aborts join attempts when a disconnect has no target channel', () => {
    const { room, emit } = createRoomHarness()
    const abortJoinAttempt = vi.fn()

    attachRoomAudio(room as never, createAttachRoomAudioDeps({
      getCurrentRoom: () => room as never,
      getTargetChannelId: () => null,
      abortJoinAttempt,
    }))

    emit(RoomEvent.Disconnected)

    expect(abortJoinAttempt).toHaveBeenCalled()
  })

  it('removes listeners for stale superseded room disconnects', () => {
    const { room, emit } = createRoomHarness()
    const onUnexpectedRoomDisconnect = vi.fn()

    attachRoomAudio(room as never, createAttachRoomAudioDeps({
      getCurrentRoom: () => null,
      onUnexpectedRoomDisconnect,
    }))

    emit(RoomEvent.Disconnected)

    expect(room.removeAllListeners).toHaveBeenCalled()
    expect(onUnexpectedRoomDisconnect).not.toHaveBeenCalled()
  })
})
