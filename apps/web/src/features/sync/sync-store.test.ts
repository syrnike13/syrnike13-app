import { describe, expect, it } from 'vitest'

import { syncStore } from '#/features/sync/sync-store'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AF'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'

describe('syncStore voice events', () => {
  it('does not emit when applying the same voice participant snapshot', () => {
    syncStore.reset()
    const participants = [
      {
        id: USER_ID,
        joined_at: 1,
        is_publishing: true,
        is_receiving: true,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
      },
    ]
    syncStore.setChannelVoiceParticipants(CHANNEL_ID, participants)

    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.setChannelVoiceParticipants(CHANNEL_ID, [
      { ...participants[0] },
    ])
    unsubscribe()

    expect(emits).toBe(0)
  })

  it('emits once when applying server members with users', () => {
    syncStore.reset()
    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.upsertMembersAndUsers(
      [
        {
          _id: {
            server: '01KT7DEM3B0T4B0BXGBXWDJ6E0',
            user: '01KT7DEM3B0T4B0BXGBXWDJ6E1',
          },
        },
      ] as never,
      [
        {
          _id: '01KT7DEM3B0T4B0BXGBXWDJ6E1',
          username: 'alice',
          online: true,
        },
      ] as never,
    )
    unsubscribe()

    expect(emits).toBe(1)
  })

  it('emits once for one bulk message delete event', () => {
    syncStore.reset()
    syncStore.setChannelMessages(CHANNEL_ID, [
      { _id: '01KT7DEM3B0T4B0BXGBXWDJ6C0', channel: CHANNEL_ID },
      { _id: '01KT7DEM3B0T4B0BXGBXWDJ6C1', channel: CHANNEL_ID },
    ] as never)
    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.handleGatewayEvent({
      type: 'BulkMessageDelete',
      channel: CHANNEL_ID,
      ids: [
        '01KT7DEM3B0T4B0BXGBXWDJ6C0',
        '01KT7DEM3B0T4B0BXGBXWDJ6C1',
      ],
    })
    unsubscribe()

    expect(emits).toBe(1)
  })

  it('emits once when a server create event includes channels', () => {
    syncStore.reset()
    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.handleGatewayEvent({
      type: 'ServerCreate',
      server: {
        _id: '01KT7DEM3B0T4B0BXGBXWDJ6D0',
        name: 'server',
      },
      channels: [
        {
          _id: '01KT7DEM3B0T4B0BXGBXWDJ6D1',
          name: 'general',
          channel_type: 'TextChannel',
          server: '01KT7DEM3B0T4B0BXGBXWDJ6D0',
        },
        {
          _id: '01KT7DEM3B0T4B0BXGBXWDJ6D2',
          name: 'voice',
          channel_type: 'VoiceChannel',
          server: '01KT7DEM3B0T4B0BXGBXWDJ6D0',
        },
      ],
    })
    unsubscribe()

    expect(emits).toBe(1)
  })

  it('emits once for a bulk gateway event', () => {
    syncStore.reset()
    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.handleGatewayEvent({
      type: 'Bulk',
      v: [
        {
          type: 'ChannelCreate',
          _id: '01KT7DEM3B0T4B0BXGBXWDJ6B0',
          name: 'general',
          channel_type: 'TextChannel',
          server: '01KT7DEM3B0T4B0BXGBXWDJ6B1',
        },
        {
          type: 'ChannelCreate',
          _id: '01KT7DEM3B0T4B0BXGBXWDJ6B2',
          name: 'voice',
          channel_type: 'VoiceChannel',
          server: '01KT7DEM3B0T4B0BXGBXWDJ6B1',
        },
      ],
    })
    unsubscribe()

    expect(emits).toBe(1)
  })

  it('moves a user out of stale channels when a join event arrives', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'VoiceChannelJoin',
      id: '01KT7DEM3B0T4B0BXGBXWDJ6AG',
      state: {
        id: USER_ID,
        joined_at: 1,
        is_publishing: true,
        is_receiving: true,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
      },
    })
    syncStore.handleGatewayEvent({
      type: 'VoiceChannelJoin',
      id: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 2,
        is_publishing: true,
        is_receiving: true,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
      },
    })

    expect(syncStore.getState().voiceParticipants).toEqual({
      [CHANNEL_ID]: {
        [USER_ID]: expect.objectContaining({
          id: USER_ID,
          joined_at: 2,
        }),
      },
    })
  })

  it('removes stale channel copies when a move event arrives', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'VoiceChannelJoin',
      id: '01KT7DEM3B0T4B0BXGBXWDJ6AG',
      state: {
        id: USER_ID,
        joined_at: 1,
        is_publishing: true,
        is_receiving: true,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
      },
    })
    syncStore.addVoiceParticipant('01KT7DEM3B0T4B0BXGBXWDJ6AH', {
      id: USER_ID,
      joined_at: 2,
      is_publishing: true,
      is_receiving: true,
      server_muted: false,
      server_deafened: false,
      camera: false,
      screensharing: false,
    })
    syncStore.handleGatewayEvent({
      type: 'VoiceChannelMove',
      user: USER_ID,
      from: '01KT7DEM3B0T4B0BXGBXWDJ6AG',
      to: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 3,
        is_publishing: true,
        is_receiving: true,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
      },
    })

    expect(syncStore.getState().voiceParticipants).toEqual({
      [CHANNEL_ID]: {
        [USER_ID]: expect.objectContaining({
          id: USER_ID,
          joined_at: 3,
        }),
      },
    })
  })

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
