import { describe, expect, it, vi } from 'vitest'

import { buildStageItems } from './voice-provider'

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
