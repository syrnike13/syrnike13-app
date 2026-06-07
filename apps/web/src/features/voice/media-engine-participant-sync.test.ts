import { beforeEach, describe, expect, it } from 'vitest'

import { syncStore } from '#/features/sync/sync-store'
import {
  applyEngineParticipantsSnapshot,
  applyEngineTrackPublished,
  applyEngineTrackUnpublished,
} from '#/features/voice/media-engine-participant-sync'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AA'
const LOCAL_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6BB'
const REMOTE_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6ZZ'

describe('media-engine-participant-sync', () => {
  beforeEach(() => {
    syncStore.setChannelVoiceParticipants(CHANNEL_ID, [
      {
        id: REMOTE_USER_ID,
        joined_at: 1,
        is_publishing: true,
        is_receiving: true,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
      },
    ])
  })

  it('merges engine participant media flags into the sync store', () => {
    applyEngineParticipantsSnapshot(
      CHANNEL_ID,
      {
        localUserId: LOCAL_USER_ID,
        localCamera: true,
        localScreensharing: false,
        participants: [
          {
            userId: REMOTE_USER_ID,
            sid: 'sid-remote',
            camera: false,
            screensharing: true,
          },
        ],
      },
      {
        localMicPublishing: true,
        localReceiving: true,
      },
    )

    const participants =
      syncStore.getState().voiceParticipants[CHANNEL_ID] ?? {}

    expect(participants[LOCAL_USER_ID]).toMatchObject({
      camera: true,
      screensharing: false,
      is_publishing: true,
    })
    expect(participants[REMOTE_USER_ID]).toMatchObject({
      screensharing: true,
      is_receiving: true,
    })
  })

  it('updates publication flags from track events', () => {
    applyEngineTrackPublished(CHANNEL_ID, REMOTE_USER_ID, 'camera')

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[REMOTE_USER_ID]
        ?.camera,
    ).toBe(true)

    applyEngineTrackUnpublished(CHANNEL_ID, REMOTE_USER_ID, 'camera')

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[REMOTE_USER_ID]
        ?.camera,
    ).toBe(false)
  })
})
