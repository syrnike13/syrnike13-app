import { describe, expect, it } from 'vitest'

import { syncStore } from '#/features/sync/sync-store'
import type { ChannelVoiceState } from '#/features/sync/voice-types'

import { applyChannelVoiceStatePayload } from './refresh-channel-voice-state'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AF'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'

function payload(participants: ChannelVoiceState['participants']) {
  return { id: CHANNEL_ID, participants }
}

describe('applyChannelVoiceStatePayload', () => {
  it('replaces a channel with an empty snapshot from voice_state', () => {
    syncStore.reset()
    syncStore.setChannelVoiceParticipants(CHANNEL_ID, [
      {
        id: USER_ID,
        joined_at: 1,
        is_publishing: true,
        is_receiving: true,
        camera: false,
        screensharing: false,
      },
    ])

    applyChannelVoiceStatePayload(payload([]))

    expect(syncStore.getState().voiceParticipants[CHANNEL_ID]).toBeUndefined()
  })

  it('keeps mute and deafen flags from the voice_state snapshot', () => {
    syncStore.reset()

    applyChannelVoiceStatePayload(
      payload([
        {
          id: USER_ID,
          joined_at: 1,
          is_publishing: false,
          is_receiving: true,
          camera: true,
          screensharing: true,
        },
      ]),
    )

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[USER_ID],
    ).toMatchObject({
      is_publishing: false,
      is_receiving: true,
      camera: true,
      screensharing: true,
    })
  })
})
