import { describe, expect, it, vi } from 'vitest'

import { syncStore } from '#/features/sync/sync-store'
import type { GatewayServerEvent } from '#/features/sync/types'

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
        version: 3,
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
      id: '01KT7DEM3B0T4B0BXGBXWDJ6D0',
      server: {
        _id: '01KT7DEM3B0T4B0BXGBXWDJ6D0',
        name: 'server',
      },
      member: {
        _id: {
          server: '01KT7DEM3B0T4B0BXGBXWDJ6D0',
          user: '01KT7DEM3B0T4B0BXGBXWDJ6D3',
        },
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
      emojis: [],
      voice_states: [],
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

  it('applies local voice join and move events directly from gateway broadcasts', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'VoiceChannelJoin',
      id: 'old-channel',
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
    syncStore.handleGatewayEvent({
      type: 'VoiceChannelMove',
      user: USER_ID,
      from: 'old-channel',
      to: CHANNEL_ID,
      operation_id: 'op-canceled',
      state: {
        id: USER_ID,
        joined_at: 3,
        self_mute: false,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 2,
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

  it('removes stale channel copies when a newer move event arrives', () => {
    syncStore.reset()
    const fromChannelId = '01KT7DEM3B0T4B0BXGBXWDJ6AH'

    syncStore.addVoiceParticipant(fromChannelId, {
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
      from: fromChannelId,
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
        version: 3,
      },
    })

    expect(syncStore.getState().voiceParticipants).toEqual({
      [CHANNEL_ID]: {
        [USER_ID]: expect.objectContaining({
          id: USER_ID,
          joined_at: 3,
          version: 3,
        }),
      },
    })
  })

  it('ignores stale move events across voice channels', () => {
    syncStore.reset()
    const newerChannelId = '01KT7DEM3B0T4B0BXGBXWDJ6AH'

    syncStore.addVoiceParticipant(newerChannelId, {
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
      from: newerChannelId,
      to: CHANNEL_ID,
      state: {
        id: USER_ID,
        joined_at: 3,
        self_mute: true,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 1,
      },
    })

    expect(syncStore.getState().voiceParticipants).toEqual({
      [newerChannelId]: {
        [USER_ID]: expect.objectContaining({
          id: USER_ID,
          self_mute: false,
          version: 2,
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

  it('ignores stale VoiceStateUpdate from another channel', () => {
    syncStore.reset()
    const newerChannelId = '01KT7DEM3B0T4B0BXGBXWDJ6AH'

    syncStore.addVoiceParticipant(newerChannelId, {
      id: USER_ID,
      joined_at: 2,
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
        joined_at: 3,
        self_mute: true,
        self_deaf: false,
        server_muted: false,
        server_deafened: false,
        camera: false,
        screensharing: false,
        version: 4,
      },
    })

    expect(syncStore.getState().voiceParticipants).toEqual({
      [newerChannelId]: {
        [USER_ID]: expect.objectContaining({
          self_mute: false,
          version: 5,
        }),
      },
    })
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

  it('tracks voice call ringing, active, and end events', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'VoiceCallRinging',
      channel_id: CHANNEL_ID,
      initiator_id: USER_ID,
      started_at: 1,
      expires_at: '2026-06-12T00:00:30.000Z',
      recipients: ['target-user'],
    })

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toEqual({
      channelId: CHANNEL_ID,
      initiatorId: USER_ID,
      phase: 'ringing',
      startedAt: 1,
      expiresAt: '2026-06-12T00:00:30.000Z',
      recipients: ['target-user'],
      declinedRecipients: [],
    })
    syncStore.dismissVoiceCall(syncStore.getState().voiceCalls[CHANNEL_ID]!)
    expect(
      Object.keys(syncStore.getState().dismissedVoiceCallKeys),
    ).toHaveLength(1)

    syncStore.handleGatewayEvent({
      type: 'VoiceCallActive',
      channel_id: CHANNEL_ID,
      initiator_id: USER_ID,
      started_at: 1,
      declined_recipients: ['target-user'],
    })

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toEqual({
      channelId: CHANNEL_ID,
      initiatorId: USER_ID,
      phase: 'active',
      startedAt: 1,
      expiresAt: undefined,
      recipients: [],
      declinedRecipients: ['target-user'],
    })
    expect(
      Object.keys(syncStore.getState().dismissedVoiceCallKeys),
    ).toHaveLength(1)

    syncStore.handleGatewayEvent({
      type: 'VoiceCallEnd',
      channel_id: CHANNEL_ID,
    })

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeUndefined()
    expect(syncStore.getState().dismissedVoiceCallKeys).toEqual({})
  })

  it('hydrates voice calls from Ready payload', () => {
    syncStore.reset()

    syncStore.applyReady({
      voice_calls: [
        {
          channel_id: CHANNEL_ID,
          initiator_id: USER_ID,
          phase: 'Ringing',
          started_at: '2026-06-12T00:00:00.000Z',
          expires_at: '2026-06-12T00:00:30.000Z',
          recipients: ['target-user'],
        },
      ],
    } as never)

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toEqual({
      channelId: CHANNEL_ID,
      initiatorId: USER_ID,
      phase: 'ringing',
      startedAt: '2026-06-12T00:00:00.000Z',
      expiresAt: '2026-06-12T00:00:30.000Z',
      recipients: ['target-user'],
      declinedRecipients: [],
    })
  })

  it('hydrates voice calls from Ready gateway events', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'Ready',
      voice_calls: [
        {
          channel_id: CHANNEL_ID,
          initiator_id: USER_ID,
          phase: 'Active',
          started_at: '2026-06-12T00:00:00.000Z',
          recipients: [],
        },
      ],
    })

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toEqual({
      channelId: CHANNEL_ID,
      initiatorId: USER_ID,
      phase: 'active',
      startedAt: '2026-06-12T00:00:00.000Z',
      expiresAt: undefined,
      recipients: [],
      declinedRecipients: [],
    })
  })

  it('normalizes lowercase voice call phases from Ready payloads', () => {
    syncStore.reset()

    syncStore.applyReady({
      voice_calls: [
        {
          channel_id: CHANNEL_ID,
          initiator_id: USER_ID,
          phase: 'active',
          started_at: '2026-06-12T00:00:00.000Z',
          recipients: [],
        },
      ],
    } as never)

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]?.phase).toBe(
      'active',
    )
  })

  it('replaces stale voice calls from an explicit Ready snapshot', () => {
    syncStore.reset()
    const call = {
      channelId: CHANNEL_ID,
      initiatorId: USER_ID,
      phase: 'ringing' as const,
      startedAt: '2026-06-12T00:00:00.000Z',
      expiresAt: '2026-06-12T00:00:30.000Z',
      recipients: ['target-user'],
      declinedRecipients: [],
    }

    syncStore.setVoiceCall(call)
    syncStore.dismissVoiceCall(call)

    syncStore.applyReady({ voice_calls: [] } as never)

    expect(syncStore.getState().voiceCalls).toEqual({})
    expect(syncStore.getState().dismissedVoiceCallKeys).toEqual({})
  })

  it('keeps dismissed call keys when Ready reports the same call as active', () => {
    syncStore.reset()
    const call = {
      channelId: CHANNEL_ID,
      initiatorId: USER_ID,
      phase: 'ringing' as const,
      startedAt: '2026-06-12T00:00:00.000Z',
      expiresAt: '2026-06-12T00:00:30.000Z',
      recipients: ['target-user'],
      declinedRecipients: [],
    }

    syncStore.setVoiceCall(call)
    syncStore.dismissVoiceCall(call)

    syncStore.applyReady({
      voice_calls: [
        {
          channel_id: CHANNEL_ID,
          initiator_id: USER_ID,
          phase: 'Active',
          started_at: '2026-06-12T00:00:00.000Z',
          recipients: [],
        },
      ],
    } as never)

    expect(syncStore.getState().voiceCalls[CHANNEL_ID]?.phase).toBe('active')
    expect(
      Object.keys(syncStore.getState().dismissedVoiceCallKeys),
    ).toHaveLength(1)
  })

  it('removes ringing voice calls when their expiry timer elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'))

    try {
      syncStore.reset()
      syncStore.handleGatewayEvent({
        type: 'VoiceCallRinging',
        channel_id: CHANNEL_ID,
        initiator_id: USER_ID,
        started_at: '2026-06-12T00:00:00.000Z',
        expires_at: '2026-06-12T00:00:01.000Z',
        recipients: ['target-user'],
      })

      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toMatchObject({
        phase: 'ringing',
        expiresAt: '2026-06-12T00:00:01.000Z',
      })

      vi.advanceTimersByTime(999)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeDefined()

      vi.advanceTimersByTime(1)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeUndefined()
    } finally {
      syncStore.reset()
      vi.useRealTimers()
    }
  })

  it('keeps expired group ringing calls joinable as active fallback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'))

    try {
      syncStore.reset()
      syncStore.applyReady({
        channels: [
          {
            _id: CHANNEL_ID,
            channel_type: 'Group',
            owner: USER_ID,
            name: 'Group',
            recipients: [USER_ID, 'target-user'],
          },
        ],
        voice_calls: [
          {
            channel_id: CHANNEL_ID,
            initiator_id: USER_ID,
            phase: 'Ringing',
            started_at: '2026-06-12T00:00:00.000Z',
            expires_at: '2026-06-12T00:00:01.000Z',
            recipients: ['target-user'],
          },
        ],
      } as never)

      vi.advanceTimersByTime(1_000)

      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toEqual({
        channelId: CHANNEL_ID,
        initiatorId: USER_ID,
        phase: 'active',
        startedAt: '2026-06-12T00:00:00.000Z',
        expiresAt: Date.parse('2026-06-12T00:00:01.000Z') + 10 * 60 * 1000,
        recipients: [],
        declinedRecipients: [],
      })

      vi.advanceTimersByTime(10 * 60 * 1000 - 1)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeDefined()

      vi.advanceTimersByTime(1)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeUndefined()
    } finally {
      syncStore.reset()
      vi.useRealTimers()
    }
  })

  it('removes active voice calls when a no-answer deadline elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'))

    try {
      syncStore.reset()
      syncStore.applyReady({
        channels: [
          {
            _id: CHANNEL_ID,
            channel_type: 'Group',
            owner: USER_ID,
            name: 'Group',
            recipients: [USER_ID, 'target-user'],
          },
        ],
        voice_calls: [
          {
            channel_id: CHANNEL_ID,
            initiator_id: USER_ID,
            phase: 'Active',
            started_at: '2026-06-12T00:00:00.000Z',
            expires_at: '2026-06-12T00:00:01.000Z',
            recipients: [],
          },
        ],
      } as never)

      vi.advanceTimersByTime(999)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeDefined()

      vi.advanceTimersByTime(1)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeUndefined()
    } finally {
      syncStore.reset()
      vi.useRealTimers()
    }
  })

  it('schedules active voice call deadlines from gateway events', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'))

    try {
      syncStore.reset()
      syncStore.handleGatewayEvent({
        type: 'VoiceCallActive',
        channel_id: CHANNEL_ID,
        initiator_id: USER_ID,
        started_at: '2026-06-12T00:00:00.000Z',
        expires_at: '2026-06-12T00:00:01.000Z',
      })

      vi.advanceTimersByTime(999)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeDefined()

      vi.advanceTimersByTime(1)
      expect(syncStore.getState().voiceCalls[CHANNEL_ID]).toBeUndefined()
    } finally {
      syncStore.reset()
      vi.useRealTimers()
    }
  })
})

describe('syncStore member events', () => {
  it('stores the full member payload from ServerMemberJoin', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'ServerMemberJoin',
      id: 'server-1',
      user: 'user-1',
      member: {
        _id: { server: 'server-1', user: 'user-1' },
        roles: ['role-1'],
        nickname: 'Ava',
      },
    } as never)

    expect(syncStore.getState().members['server-1:user-1']).toEqual({
      _id: { server: 'server-1', user: 'user-1' },
      roles: ['role-1'],
      nickname: 'Ava',
    })
  })

  it('applies ServerMemberUpdate data after clear fields to unloaded members', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'ServerMemberUpdate',
      id: { server: 'server-1', user: 'user-1' },
      data: { nickname: 'Ava', roles: ['role-1'] },
      clear: ['Nickname', 'Roles'],
    } as never)

    expect(syncStore.getState().members['server-1:user-1']).toEqual({
      _id: { server: 'server-1', user: 'user-1' },
      roles: ['role-1'],
      nickname: 'Ava',
    })
  })

  it('removes the server state when the current user leaves it', () => {
    syncStore.reset()
    syncStore.setCurrentUserId('user-1')
    syncStore.applyReady({
      servers: [{ _id: 'server-1', name: 'Alpha' }],
      channels: [
        {
          _id: 'channel-1',
          name: 'general',
          channel_type: 'TextChannel',
          server: 'server-1',
        },
      ],
      users: [],
      members: [
        {
          _id: { server: 'server-1', user: 'user-1' },
        },
      ],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)
    syncStore.setSelectedServerId('server-1')

    syncStore.handleGatewayEvent({
      type: 'ServerMemberLeave',
      id: 'server-1',
      user: 'user-1',
    })

    expect(syncStore.getState().servers['server-1']).toBeUndefined()
    expect(syncStore.getState().channels['channel-1']).toBeUndefined()
    expect(syncStore.getState().members['server-1:user-1']).toBeUndefined()
    expect(syncStore.getState().selectedServerId).toBeNull()
  })
})

describe('syncStore server events', () => {
  it('applies ServerUpdate clear fields before data', () => {
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Alpha',
      description: 'Old description',
      categories: [{ id: 'category-1', title: 'Old', channels: [] }],
      icon: { _id: 'icon-1' },
    } as never)

    syncStore.handleGatewayEvent({
      type: 'ServerUpdate',
      id: 'server-1',
      clear: ['Description', 'Categories', 'Icon'],
      data: { description: 'New description' },
    })

    const server = syncStore.getState().servers['server-1']
    expect(server?.description).toBe('New description')
    expect(server?.categories).toBeUndefined()
    expect(server?.icon).toBeUndefined()
  })

  it('hydrates a server join bundle in one emission', () => {
    syncStore.reset()
    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.applyServerJoinBundle({
      server: { _id: 'server-1', name: 'Alpha' } as never,
      member: {
        _id: { server: 'server-1', user: 'user-1' },
      } as never,
      channels: [
        {
          _id: 'channel-1',
          channel_type: 'TextChannel',
          server: 'server-1',
          name: 'general',
        } as never,
      ],
    })
    unsubscribe()

    const state = syncStore.getState()
    expect(emits).toBe(1)
    expect(state.servers['server-1']?._id).toBe('server-1')
    expect(state.members['server-1:user-1']?._id.user).toBe('user-1')
    expect(state.channels['channel-1']?._id).toBe('channel-1')
  })

  it('hydrates emojis from a ServerCreate gateway event', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'ServerCreate',
      server: { _id: 'server-1', name: 'Alpha' },
      member: { _id: { server: 'server-1', user: 'user-1' } },
      channels: [],
      emojis: [{ _id: 'emoji-1', name: 'wave' }],
      voice_states: [
        {
          id: 'voice-1',
          participants: [
            {
              id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              joined_at: 1,
              self_mute: false,
              self_deaf: false,
              server_muted: false,
              server_deafened: false,
              screensharing: false,
              camera: false,
              version: 1,
            },
          ],
        },
      ],
    })

    expect(syncStore.getState().emojis['emoji-1']?.name).toBe('wave')
    expect(
      syncStore.getState().voiceParticipants['voice-1']?.[
        '01ARZ3NDEKTSV4RRFFQ69G5FAV'
      ]?.version,
    ).toBe(1)
  })

  it('hydrates server emojis and group join data in one emission each', () => {
    syncStore.reset()
    let emits = 0
    const unsubscribe = syncStore.subscribe(() => {
      emits += 1
    })

    syncStore.applyServerJoinBundle({
      server: { _id: 'server-1', name: 'Alpha' } as never,
      member: {
        _id: { server: 'server-1', user: 'user-1' },
      } as never,
      channels: [],
      emojis: [{ _id: 'emoji-1', name: 'wave' } as never],
    })
    syncStore.applyGroupJoinBundle({
      channel: {
        _id: 'group-1',
        channel_type: 'Group',
        recipients: ['user-1', 'user-2'],
      } as never,
      users: [{ _id: 'user-2', username: 'friend' } as never],
    })
    unsubscribe()

    const state = syncStore.getState()
    expect(emits).toBe(2)
    expect(state.emojis['emoji-1']?.name).toBe('wave')
    expect(state.channels['group-1']?._id).toBe('group-1')
    expect(state.users['user-2']?.username).toBe('friend')
  })

  it('applies ServerMemberUpdate clear fields before data', () => {
    syncStore.reset()
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        roles: ['old-role'],
        nickname: 'Old nickname',
      } as never,
    ])

    syncStore.handleGatewayEvent({
      type: 'ServerMemberUpdate',
      id: { server: 'server-1', user: 'user-1' },
      clear: ['Roles', 'Nickname'],
      data: { roles: ['new-role'] },
    })

    const member = syncStore.getState().members['server-1:user-1']
    expect(member?.roles).toEqual(['new-role'])
    expect(member?.nickname).toBeUndefined()
  })
})

describe('syncStore role events', () => {
  it('applies ServerRoleUpdate clear fields before data', () => {
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Alpha',
      roles: {
        'role-1': {
          _id: 'role-1',
          name: 'Role',
          colour: 'red',
          icon: { _id: 'icon-1' },
        },
      },
    } as never)

    syncStore.handleGatewayEvent({
      type: 'ServerRoleUpdate',
      id: 'server-1',
      role_id: 'role-1',
      clear: ['Colour', 'Icon'],
      data: { colour: 'blue' },
    })

    const role = syncStore.getState().servers['server-1']?.roles?.['role-1']
    expect(role?.colour).toBe('blue')
    expect(role?.icon).toBeUndefined()
  })

  it('removes deleted roles from loaded members and channel overwrites', () => {
    syncStore.reset()
    syncStore.applyReady({
      servers: [
        {
          _id: 'server-1',
          name: 'Alpha',
          roles: {
            'role-1': {
              _id: 'role-1',
              name: 'Deleted',
              rank: 1,
            },
            'role-2': {
              _id: 'role-2',
              name: 'Kept',
              rank: 2,
            },
          },
        },
      ],
      channels: [
        {
          _id: 'channel-1',
          channel_type: 'TextChannel',
          server: 'server-1',
          name: 'general',
          role_permissions: {
            'role-1': { a: 1, d: 0 },
            'role-2': { a: 2, d: 0 },
          },
        },
      ],
      users: [],
      members: [
        {
          _id: { server: 'server-1', user: 'user-1' },
          roles: ['role-1', 'role-2'],
        },
        {
          _id: { server: 'server-1', user: 'user-2' },
          roles: ['role-1'],
        },
        {
          _id: { server: 'server-2', user: 'user-3' },
          roles: ['role-1'],
        },
      ],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    syncStore.handleGatewayEvent({
      type: 'ServerRoleDelete',
      id: 'server-1',
      role_id: 'role-1',
    })

    const state = syncStore.getState()
    expect(state.servers['server-1']?.roles?.['role-1']).toBeUndefined()
    expect(state.members['server-1:user-1']?.roles).toEqual(['role-2'])
    expect(state.members['server-1:user-2']?.roles).toEqual([])
    expect(state.members['server-2:user-3']?.roles).toEqual(['role-1'])
    expect(
      state.channels['channel-1']?.role_permissions?.['role-1'],
    ).toBeUndefined()
    expect(state.channels['channel-1']?.role_permissions?.['role-2']).toEqual({
      a: 2,
      d: 0,
    })
  })
})

describe('syncStore applyReady', () => {
  it('hydrates channel unread mention ids from Ready payloads', () => {
    syncStore.reset()

    syncStore.applyReady({
      servers: [],
      channels: [],
      users: [],
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: CHANNEL_ID, user: USER_ID },
          last_id: '01KT7DEM3B0T4B0BXGBXWDJ6B0',
          mentions: [
            '01KT7DEM3B0T4B0BXGBXWDJ6B1',
            '01KT7DEM3B0T4B0BXGBXWDJ6B2',
          ],
        },
      ],
      voice_states: [],
    } as never)

    expect(syncStore.getState().unreads[CHANNEL_ID]).toEqual({
      lastId: '01KT7DEM3B0T4B0BXGBXWDJ6B0',
      mentions: [
        '01KT7DEM3B0T4B0BXGBXWDJ6B1',
        '01KT7DEM3B0T4B0BXGBXWDJ6B2',
      ],
    })
  })

  it('clears local mention unread ids when marking a channel read', () => {
    syncStore.reset()

    syncStore.setUnreads([
      {
        _id: { channel: CHANNEL_ID, user: USER_ID },
        last_id: '01KT7DEM3B0T4B0BXGBXWDJ6B0',
        mentions: ['01KT7DEM3B0T4B0BXGBXWDJ6B1'],
      },
    ])
    syncStore.setChannelLastRead(CHANNEL_ID, '01KT7DEM3B0T4B0BXGBXWDJ6B1')

    expect(syncStore.getState().unreads[CHANNEL_ID]).toEqual({
      lastId: '01KT7DEM3B0T4B0BXGBXWDJ6B1',
      mentions: [],
    })
  })

  it('preserves null selectedServerId instead of auto-selecting the first server', () => {
    syncStore.reset()

    syncStore.applyReady({
      servers: [{ _id: 'server-1', name: 'Alpha' }],
      channels: [],
      users: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    expect(syncStore.getState().selectedServerId).toBeNull()
  })

  it('preserves an existing selected server across reconnect', () => {
    syncStore.reset()
    syncStore.setSelectedServerId('server-2')

    syncStore.applyReady({
      servers: [
        { _id: 'server-1', name: 'Alpha' },
        { _id: 'server-2', name: 'Beta' },
      ],
      channels: [],
      users: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    expect(syncStore.getState().selectedServerId).toBe('server-2')
  })
})

describe('syncStore server membership events', () => {
  it('uses the full member payload from ServerMemberJoin', () => {
    syncStore.reset()

    const event = {
      type: 'ServerMemberJoin',
      id: 'server-1',
      user: 'user-2',
      member: {
        _id: { server: 'server-1', user: 'user-2' },
        joined_at: '2026-06-16T12:00:00.000Z',
        roles: ['member-role'],
        can_publish: false,
      },
    } as const satisfies GatewayServerEvent
    syncStore.handleGatewayEvent(event)

    expect(syncStore.getState().members['server-1:user-2']).toMatchObject({
      _id: { server: 'server-1', user: 'user-2' },
      joined_at: '2026-06-16T12:00:00.000Z',
      roles: ['member-role'],
      can_publish: false,
    })
  })

  it('upgrades an existing placeholder member from ServerMemberJoin payload', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'ServerMemberJoin',
      id: 'server-1',
      user: 'user-2',
    } as const satisfies GatewayServerEvent)

    const event = {
      type: 'ServerMemberJoin',
      id: 'server-1',
      user: 'user-2',
      member: {
        _id: { server: 'server-1', user: 'user-2' },
        joined_at: '2026-06-16T12:00:00.000Z',
        roles: ['member-role'],
        can_publish: false,
      },
    } as const satisfies GatewayServerEvent
    syncStore.handleGatewayEvent(event)

    expect(syncStore.getState().members['server-1:user-2']).toMatchObject({
      roles: ['member-role'],
      can_publish: false,
    })
  })

  it('stores the current user member from ServerCreate', () => {
    syncStore.reset()

    const event = {
      type: 'ServerCreate',
      id: 'server-1',
      server: { _id: 'server-1', owner: 'owner-1', name: 'Test', channels: [] },
      channels: [],
      member: {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2026-06-16T12:00:00.000Z',
      },
    } as const satisfies GatewayServerEvent
    syncStore.handleGatewayEvent(event)

    expect(syncStore.getState().members['server-1:user-1']).toMatchObject({
      _id: { server: 'server-1', user: 'user-1' },
      joined_at: '2026-06-16T12:00:00.000Z',
    })
  })
})
