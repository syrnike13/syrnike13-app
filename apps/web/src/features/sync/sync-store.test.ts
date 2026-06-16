import { describe, expect, it, vi } from 'vitest'

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

describe('syncStore applyReady', () => {
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

  it('clears stale music presences because Ready has no music snapshot', () => {
    syncStore.reset()
    syncStore.setUserMusicPresence(USER_ID, {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'PRAXX',
      artists: ['DK'],
      isPlaying: true,
      observedAt: 1_718_100_000_000,
    })

    syncStore.applyReady({
      servers: [],
      channels: [],
      users: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    })

    expect(syncStore.getState().musicPresences).toEqual({})
  })
})

describe('syncStore music presence events', () => {
  it('stores and clears user music presence updates', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'UserMusicPresence',
      id: USER_ID,
      presence: {
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'PRAXX',
        artists: ['DK'],
        album: 'Kino',
        artworkUrl: 'https://cdn.example/praxx.jpg',
        externalUrl: 'https://open.spotify.com/track/1',
        durationMs: 225000,
        progressMs: 15000,
        isPlaying: true,
        observedAt: 1_718_100_000_000,
      },
    })

    expect(syncStore.getState().musicPresences[USER_ID]).toMatchObject({
      provider: 'spotify',
      title: 'PRAXX',
      artists: ['DK'],
    })

    syncStore.handleGatewayEvent({
      type: 'UserMusicPresence',
      id: USER_ID,
      presence: null,
    })

    expect(syncStore.getState().musicPresences[USER_ID]).toBeUndefined()
  })

  it('clears user music presence when a gateway patch says playback paused', () => {
    syncStore.reset()

    syncStore.handleGatewayEvent({
      type: 'UserMusicPresence',
      id: USER_ID,
      presence: {
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'PRAXX',
        artists: ['DK'],
        durationMs: 225000,
        progressMs: 15000,
        isPlaying: true,
        observedAt: 1_718_100_000_000,
      },
    })

    syncStore.handleGatewayEvent({
      type: 'UserMusicPresence',
      id: USER_ID,
      presence: {
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'PRAXX',
        artists: ['DK'],
        durationMs: 225000,
        progressMs: 45000,
        isPlaying: false,
        observedAt: 1_718_100_030_000,
      },
    })

    expect(syncStore.getState().musicPresences[USER_ID]).toBeUndefined()
  })

  it('does not store paused music presence patches directly', () => {
    syncStore.reset()

    syncStore.setUserMusicPresence(USER_ID, {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Paused track',
      artists: ['Artist'],
      durationMs: 180000,
      progressMs: 60000,
      isPlaying: false,
      observedAt: 1_718_100_000_000,
    })

    expect(syncStore.getState().musicPresences[USER_ID]).toBeUndefined()
  })
})
