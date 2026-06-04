import { describe, expect, it } from 'vitest'
import { Track } from 'livekit-client'

import { syncStore } from '#/features/sync/sync-store'
import { syncLiveKitRoomParticipants } from '#/features/voice/voice-participant-sync'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AF'
const LOCAL_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const REMOTE_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AE'

function participant(identity: string) {
  return {
    identity,
    joinedAt: new Date('2026-06-04T12:00:00.000Z'),
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
    trackPublications: new Map([
      [
        'microphone',
        {
          kind: Track.Kind.Audio,
          source: Track.Source.Microphone,
          track: {},
          isMuted: false,
          isSubscribed: true,
        },
      ],
    ]),
  }
}

describe('syncLiveKitRoomParticipants', () => {
  it('syncs remote participants without reading existing voice state before initialization', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID),
      remoteParticipants: new Map([[REMOTE_USER_ID, participant(REMOTE_USER_ID)]]),
    }

    expect(() =>
      syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true),
    ).not.toThrow()
    expect(syncStore.getState().voiceParticipants[CHANNEL_ID]).toMatchObject({
      [LOCAL_USER_ID]: {
        id: LOCAL_USER_ID,
        is_publishing: true,
        is_receiving: true,
      },
      [REMOTE_USER_ID]: {
        id: REMOTE_USER_ID,
        is_publishing: true,
        is_receiving: true,
      },
    })
  })
})
