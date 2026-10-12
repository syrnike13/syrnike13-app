import { describe, expect, it, vi } from 'vitest'

import { buildStageItems, type StageRoom } from './voice-stage-items'

describe('desktop voice stage channel scope', () => {
  it('shows the local native camera track as the current user self-view', () => {
    const track = { kind: 'video' }
    const items = buildStageItems({
      room: null,
      participants: [{ id: 'local' }],
      currentUserId: 'local',
      filters: {
        showOwnStream: true,
        showRemoteStreams: true,
        showParticipantsWithoutMedia: true,
      },
      watchedRemoteScreenIds: new Set(),
      nativeTracks: [{
        sessionId: 'voice-session',
        generation: 2,
        trackId: 'camera-publication',
        participantIdentity: 'voice:v1|windows_native|client|epoch|op|local',
        source: 'camera',
        local: true,
        sequence: 1,
        rendererEpoch: 0,
        track: track as never,
        consumerCount: 0,
      }],
      nativePublications: [],
      localScreenPreview: null,
      setNativeDemand: vi.fn(),
    })

    expect(items).toContainEqual(expect.objectContaining({
      id: 'local:camera',
      userId: 'local',
      kind: 'camera',
      isLocal: true,
      track: {
        backend: 'native',
        track,
      },
    }))
  })

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

  it('exposes a terminal native subscription failure instead of loading forever', () => {
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

  it('routes an explicit retry after terminal native subscription failure', () => {
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

    items[0]?.publication?.setSubscribed?.(true)

    expect(setNativeDemand).toHaveBeenCalledOnce()
    expect(setNativeDemand).toHaveBeenCalledWith(
      'voice-session',
      2,
      'screen',
      true,
    )
  })

  it('creates demand for a visible native camera before its first frame', () => {
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
      watchedRemoteScreenIds: new Set(),
      nativeTracks: [],
      nativePublications: [{
        ...publication('remote', 'camera'),
        source: 'camera',
      }],
      localScreenPreview: null,
      setNativeDemand,
    })

    expect(items).toContainEqual(expect.objectContaining({
      id: 'remote:camera',
      subscribed: true,
      track: null,
    }))
    const camera = items.find((item) => item.id === 'remote:camera')
    camera?.publication?.setSubscribed?.(true)
    expect(setNativeDemand).toHaveBeenCalledWith(
      'voice-session',
      2,
      'camera',
      true,
    )
  })

  it('exposes a browser screen subscription failure instead of loading forever', () => {
    const room = {
      localParticipant: {
        identity: 'local',
        tracks: [],
      },
      remoteParticipants: [{
        identity: 'remote',
        tracks: [{
          source: 'screen',
          track: null,
          publication: {
            backend: 'livekit',
            source: 'screen',
            isSubscribed: false,
            isMuted: false,
          },
          subscribed: false,
          live: true,
          error: 'Не удалось подключиться к демонстрации: server_rejected',
        }],
      }],
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
