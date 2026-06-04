import { describe, expect, it } from 'vitest'

import { syncStore } from '#/features/sync/sync-store'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AF'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'

describe('syncStore voice events', () => {
  it('applies UserVoiceStateUpdate even when the join snapshot was missed', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'UserVoiceStateUpdate',
      id: USER_ID,
      channel_id: CHANNEL_ID,
      data: { is_publishing: true },
    })

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[USER_ID],
    ).toMatchObject({
      id: USER_ID,
      is_publishing: true,
      is_receiving: true,
    })
  })
})
