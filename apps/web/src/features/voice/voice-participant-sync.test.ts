import { describe, expect, it } from 'vitest'
import { Track } from 'livekit-client'

import { syncStore } from '#/features/sync/sync-store'
import { syncLiveKitRoomParticipants } from '#/features/voice/voice-participant-sync'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AF'
const LOCAL_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const REMOTE_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AE'

function participant(
  identity: string,
  publication: {
    track?: unknown
    isMuted?: boolean
    isSubscribed?: boolean
    isMicrophoneEnabled?: boolean
  } = {},
) {
  const value: Record<string, unknown> = {
    identity,
    joinedAt: new Date('2026-06-04T12:00:00.000Z'),
    isCameraEnabled: false,
    isScreenShareEnabled: false,
    trackPublications: new Map([
      [
        'microphone',
        {
          kind: Track.Kind.Audio,
          source: Track.Source.Microphone,
          track: publication.track ?? {},
          isMuted: publication.isMuted ?? false,
          isSubscribed: publication.isSubscribed ?? true,
        },
      ],
    ]),
  }

  if (publication.isMicrophoneEnabled !== undefined) {
    value.isMicrophoneEnabled = publication.isMicrophoneEnabled
  }

  return value
}

describe('syncLiveKitRoomParticipants', () => {
  it('syncs remote participants without reading existing voice state before initialization', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
      }),
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

  it('keeps remote microphone enabled when publication is not subscribed yet', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
      }),
      remoteParticipants: new Map([
        [
          REMOTE_USER_ID,
          participant(REMOTE_USER_ID, {
            track: undefined,
            isSubscribed: false,
          }),
        ],
      ]),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[REMOTE_USER_ID],
    ).toMatchObject({
      id: REMOTE_USER_ID,
      is_publishing: true,
    })
  })
})
