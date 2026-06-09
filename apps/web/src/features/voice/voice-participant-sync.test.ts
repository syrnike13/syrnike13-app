import { describe, expect, it } from 'vitest'

import { syncStore } from '#/features/sync/sync-store'
import {
  liveKitRoomParticipantIds,
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
} from '#/features/voice/voice-participant-sync'

const LOCAL_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const REMOTE_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AE'

describe('liveKitRoomParticipantIds', () => {
  it('returns base user ids from room participants', () => {
    const room = {
      localParticipant: { identity: LOCAL_USER_ID },
      remoteParticipants: new Map([
        ['remote', { identity: `${REMOTE_USER_ID}:desktop-native:screen` }],
      ]),
    }

    expect(liveKitRoomParticipantIds(room as never)).toEqual([
      LOCAL_USER_ID,
      REMOTE_USER_ID,
    ])
  })

  it('excludes native identities listed in excludedParticipantIdentities', () => {
    const nativeIdentity = `${LOCAL_USER_ID}:desktop-native:screen`
    const room = {
      localParticipant: { identity: LOCAL_USER_ID },
      remoteParticipants: new Map([[nativeIdentity, { identity: nativeIdentity }]]),
    }

    expect(
      liveKitRoomParticipantIds(room as never, {
        excludedParticipantIdentities: new Set([nativeIdentity]),
      }),
    ).toEqual([LOCAL_USER_ID])
  })
})

describe('local voice flag patches', () => {
  it('updates self_mute and self_deaf in sync store', () => {
    syncStore.reset()
    syncStore.addVoiceParticipant('channel-1', {
      id: LOCAL_USER_ID,
      joined_at: 1,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      camera: false,
      screensharing: false,
      version: 1,
    })

    patchLocalVoiceMic('channel-1', LOCAL_USER_ID, false)
    patchLocalVoiceDeafen('channel-1', LOCAL_USER_ID, true)

    expect(
      syncStore.getState().voiceParticipants['channel-1']?.[LOCAL_USER_ID],
    ).toMatchObject({
      self_mute: true,
      self_deaf: true,
    })
  })
})
