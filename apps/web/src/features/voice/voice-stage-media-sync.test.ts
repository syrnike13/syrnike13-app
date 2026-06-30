import { describe, expect, it, vi } from 'vitest'
import {
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client'

import {
  applyRemoteScreenParticipantSubscription,
  stageMediaTrackSource,
  syncRoomParticipants,
  syncStageMediaItems,
} from '#/features/voice/voice-stage-media-sync'
import {
  hasCurrentNativeScreenPublication,
} from '#/features/voice/native-screen-publication-loss'
import type { NativeMediaState } from '#/features/voice/native-media-coordinator'
import type { StageMediaFilters } from '#/features/voice/voice-stage-media'

describe('voice stage media sync helpers', () => {
  it('maps LiveKit track sources to stage media sources', () => {
    expect(stageMediaTrackSource(Track.Source.ScreenShare)).toBe('screen')
    expect(stageMediaTrackSource(Track.Source.Camera)).toBe('camera')
    expect(stageMediaTrackSource(Track.Source.Microphone)).toBeNull()
  })

  it('finds the current native screen publication in room participants', () => {
    const publication = {
      source: Track.Source.ScreenShare,
      trackSid: 'screen-publication',
    } as RemoteTrackPublication
    const room = {
      remoteParticipants: new Map([
        [
          'native-screen-participant',
          {
            trackPublications: new Map([['screen', publication]]),
          },
        ],
      ]),
    } as unknown as Room
    const screen = {
      status: 'published',
      participantIdentity: 'native-screen-participant',
      publicationSid: 'screen-publication',
    } as NativeMediaState['screen']

    expect(hasCurrentNativeScreenPublication(room, screen)).toBe(true)
  })

  it('returns false when native screen state is not published', () => {
    expect(
      hasCurrentNativeScreenPublication({} as Room, {
        status: 'idle',
      } as NativeMediaState['screen']),
    ).toBe(false)
  })

  it('applies an explicit remote screen subscription choice to every publication', () => {
    const publications = [
      { source: Track.Source.ScreenShare, setSubscribed: vi.fn() },
      { source: Track.Source.ScreenShareAudio, setSubscribed: vi.fn() },
    ] as unknown as RemoteTrackPublication[]
    const participant = {
      identity: 'remote-user:desktop-native:screen-1',
      trackPublications: new Map(publications.map((publication, index) => [
        `publication-${index}`,
        publication,
      ])),
    } as unknown as RemoteParticipant

    const subscribed = applyRemoteScreenParticipantSubscription(participant, {
      subscribed: false,
      currentUserId: 'local-user',
      localParticipantIdentity: 'local-user',
      watchedRemoteScreenIds: new Set(),
      pendingScreenWatchIds: new Set(),
    })

    expect(subscribed).toBe(false)
    expect(publications[0].setSubscribed).toHaveBeenCalledWith(false)
    expect(publications[1].setSubscribed).toHaveBeenCalledWith(false)
  })

  it('subscribes remote watched screens when no explicit choice is passed', () => {
    const publication = {
      source: Track.Source.ScreenShare,
      setSubscribed: vi.fn(),
    } as unknown as RemoteTrackPublication
    const participant = {
      identity: 'remote-user',
      trackPublications: new Map([['screen', publication]]),
    } as unknown as RemoteParticipant

    const subscribed = applyRemoteScreenParticipantSubscription(participant, {
      currentUserId: 'local-user',
      localParticipantIdentity: 'local-user',
      watchedRemoteScreenIds: new Set(['remote-user:screen']),
      pendingScreenWatchIds: new Set(),
    })

    expect(subscribed).toBe(true)
    expect(publication.setSubscribed).toHaveBeenCalledWith(true)
  })

  it('syncs local room participant media and stage items', () => {
    const room = {
      localParticipant: {
        trackPublications: new Map([
          [
            'camera',
            {
              kind: Track.Kind.Video,
              source: Track.Source.Camera,
              isMuted: false,
              track: {},
            },
          ],
        ]),
      },
    } as unknown as Room
    const setCameraEnabled = vi.fn()
    const setScreenShareEnabled = vi.fn()
    const patchLocalVoiceCamera = vi.fn()
    const syncStageMediaItems = vi.fn()

    syncRoomParticipants({
      room,
      nativeMediaState: {
        screen: { status: 'published', visibleInRoom: true },
      } as NativeMediaState,
      activeChannelId: 'voice-a',
      userId: 'user-1',
      setCameraEnabled,
      setScreenShareEnabled,
      patchLocalVoiceCamera,
      syncStageMediaItems,
    })

    expect(setCameraEnabled).toHaveBeenCalledWith(true)
    expect(setScreenShareEnabled).toHaveBeenCalledWith(true)
    expect(patchLocalVoiceCamera).toHaveBeenCalledWith('voice-a', 'user-1', true)
    expect(syncStageMediaItems).toHaveBeenCalledWith(room)
  })

  it('builds stage media items and promotes visible pending remote screens to watched', () => {
    const localUserId = '507f1f77bcf86cd799439011'
    const remoteUserId = '507f1f77bcf86cd799439012'
    const localCameraTrack = { kind: Track.Kind.Video }
    const localCameraPublication = {
      source: Track.Source.Camera,
      track: localCameraTrack,
      isMuted: false,
      isSubscribed: true,
    }
    const remoteScreenPublication = {
      source: Track.Source.ScreenShare,
      track: { kind: Track.Kind.Video },
      isMuted: false,
      isSubscribed: false,
      setSubscribed: vi.fn(),
    }
    const remoteParticipant = {
      identity: remoteUserId,
      trackPublications: new Map([['screen', remoteScreenPublication]]),
    }
    const room = {
      localParticipant: {
        identity: localUserId,
        trackPublications: new Map([['camera', localCameraPublication]]),
      },
      remoteParticipants: new Map([[remoteUserId, remoteParticipant]]),
    } as unknown as Room
    const watchedRemoteScreenIds = new Set<string>()
    const pendingScreenWatchIds = new Set([`${remoteUserId}:screen`])
    const setStageMediaItems = vi.fn()

    syncStageMediaItems({
      room,
      nativeMediaState: {
        screen: { status: 'idle' },
      } as NativeMediaState,
      stoppedNativeScreenIdentity: null,
      authUserId: localUserId,
      stageMediaFilters: {
        showOwnStream: true,
        showRemoteStreams: true,
        showParticipantsWithoutMedia: true,
      } satisfies StageMediaFilters,
      watchedRemoteScreenIds,
      pendingScreenWatchIds,
      lastStageSyncDebugKey: { current: null },
      applyRemoteScreenParticipantSubscription: vi.fn(),
      setStageMediaItems,
      onNativeScreenPublicationLost: vi.fn(),
      logStageSyncDebug: vi.fn(),
    })

    expect(setStageMediaItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${localUserId}:camera`,
          userId: localUserId,
          kind: 'camera',
          isLocal: true,
        }),
        expect.objectContaining({
          id: `${remoteUserId}:screen`,
          userId: remoteUserId,
          kind: 'screen',
          isLocal: false,
          subscribed: true,
        }),
      ]),
    )
    expect(remoteScreenPublication.setSubscribed).toHaveBeenCalledWith(true)
    expect(pendingScreenWatchIds.has(`${remoteUserId}:screen`)).toBe(false)
    expect(watchedRemoteScreenIds.has(`${remoteUserId}:screen`)).toBe(true)
  })
})
