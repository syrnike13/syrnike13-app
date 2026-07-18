import { describe, expect, it, vi } from 'vitest'
import { Track } from 'livekit-client'

import { buildStageItems, type StageRoom } from './voice-stage-items'

describe('desktop voice stage channel scope', () => {
  it('does not add native publications owned by users in another voice channel', () => {
    const items = buildStageItems({
      room: null,
      participants: [{ id: 'test_isa' }, { id: 'tiredisa' }],
      currentUserId: 'tiredisa',
      filters: {
        showOwnStream: true,
        showRemoteStreams: true,
        showParticipantsWithoutMedia: true,
      },
      watchedRemoteScreenIds: new Set(),
      nativeTracks: [],
      nativePublications: [
        publication('nioh31', 'old-screen'),
        publication('test_isa', 'current-screen'),
      ],
      localScreenPreview: null,
      setNativeDemand: vi.fn(),
    })

    expect(items.some((item) => item.userId === 'nioh31')).toBe(false)
    expect(items).toContainEqual(
      expect.objectContaining({
        id: 'test_isa:screen',
        userId: 'test_isa',
        kind: 'screen',
      }),
    )
  })

  it('exposes an exhausted native subscription as retryable instead of loading', () => {
    const items = buildStageItems({
      room: null,
      participants: [{ id: 'remote' }],
      currentUserId: 'local',
      filters: {
        showOwnStream: true,
        showRemoteStreams: true,
        showParticipantsWithoutMedia: true,
      },
      watchedRemoteScreenIds: new Set(['remote:screen']),
      nativeTracks: [],
      nativePublications: [{
        ...publication('remote', 'screen'),
        error: 'Не удалось подключиться к демонстрации после 10 попыток',
      }],
      localScreenPreview: null,
      setNativeDemand: vi.fn(),
    })

    expect(items).toContainEqual(expect.objectContaining({
      id: 'remote:screen',
      subscribed: true,
      track: null,
      error: 'Не удалось подключиться к демонстрации после 10 попыток',
    }))
  })

  it('routes one native UI subscription action through the demand coordinator', () => {
    const setNativeDemand = vi.fn()
    const items = buildStageItems({
      room: null,
      participants: [{ id: 'remote' }],
      currentUserId: 'local',
      filters: {
        showOwnStream: true,
        showRemoteStreams: true,
        showParticipantsWithoutMedia: true,
      },
      watchedRemoteScreenIds: new Set(['remote:screen']),
      nativeTracks: [],
      nativePublications: [publication('remote', 'screen')],
      localScreenPreview: null,
      setNativeDemand,
    })

    items[0]?.publication?.setSubscribed?.(false)

    expect(setNativeDemand).toHaveBeenCalledOnce()
    expect(setNativeDemand).toHaveBeenCalledWith(
      'voice-session',
      2,
      'screen',
      false,
    )
  })

  it('exposes a browser screen subscription failure instead of loading forever', () => {
    const publication = {
      source: Track.Source.ScreenShare,
      isSubscribed: false,
      isMuted: false,
      videoTrack: null,
      subscriptionError: 'server_rejected',
    }
    const remoteParticipant = {
      identity: 'remote',
      trackPublications: new Map([['screen', publication]]),
    }
    const room = {
      localParticipant: {
        identity: 'local',
        trackPublications: new Map(),
      },
      remoteParticipants: new Map([['remote', remoteParticipant]]),
    } satisfies StageRoom

    const items = buildStageItems({
      room,
      participants: [{ id: 'remote' }],
      currentUserId: 'local',
      filters: {
        showOwnStream: true,
        showRemoteStreams: true,
        showParticipantsWithoutMedia: true,
      },
      watchedRemoteScreenIds: new Set(['remote:screen']),
      nativeTracks: [],
      nativePublications: [],
      localScreenPreview: null,
      setNativeDemand: vi.fn(),
    })

    expect(items).toContainEqual(expect.objectContaining({
      id: 'remote:screen',
      track: null,
      error: 'Не удалось подключиться к демонстрации: server_rejected',
    }))
  })
})

function publication(participantIdentity: string, trackId: string) {
  return {
    sessionId: 'voice-session',
    generation: 2,
    trackId,
    demandTrackId: trackId,
    participantIdentity,
    source: 'screen' as const,
    track: null,
  }
}
