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
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 1,
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
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 1,
      },
    })
    syncStore.handleGatewayEvent({
      type: 'VoiceChannelJoin',
      id: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 2,
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 1,
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
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 1,
      },
    })
    syncStore.addVoiceParticipant('01KT7DEM3B0T4B0BXGBXWDJ6AH', {
      id: USER_ID,
      joined_at: 2,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      camera: false,
      screensharing: false,
      version: 2,
    })
    syncStore.handleGatewayEvent({
      type: 'VoiceChannelMove',
      user: USER_ID,
      from: '01KT7DEM3B0T4B0BXGBXWDJ6AG',
      to: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 3,
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 1,
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

  it('applies VoiceStateUpdate even when the join snapshot was missed', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'VoiceStateUpdate',
      channel_id: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 1,
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 2,
      },
    })

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[USER_ID],
    ).toMatchObject({
      id: USER_ID,
      self_mute: false,
      self_deaf: false,
      version: 2,
    })
  })

  it('ignores stale VoiceStateUpdate with lower version', () => {
    syncStore.reset()
    syncStore.addVoiceParticipant(CHANNEL_ID, {
      id: USER_ID,
      joined_at: 1,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      camera: false,
      screensharing: false,
      version: 5,
    })

    syncStore.handleGatewayEvent({
      type: 'VoiceStateUpdate',
      channel_id: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 1,
        self_mute: true,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 3,
      },
    })

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[USER_ID]?.self_mute,
    ).toBe(false)
  })

  it('keeps local optimistic patches ahead of same-version snapshots', () => {
    syncStore.reset()
    syncStore.addVoiceParticipant(CHANNEL_ID, {
      id: USER_ID,
      joined_at: 1,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      camera: false,
      screensharing: false,
      version: 5,
    })

    syncStore.patchVoiceParticipant(CHANNEL_ID, USER_ID, {
      self_mute: true,
    })
    syncStore.handleGatewayEvent({
      type: 'VoiceStateUpdate',
      channel_id: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 1,
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 5,
      },
    })

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[USER_ID]?.self_mute,
    ).toBe(true)
  })
})
