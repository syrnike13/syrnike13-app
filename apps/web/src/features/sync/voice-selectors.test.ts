import { describe, expect, it } from 'vitest'

import {
  applyLocalVoiceSessionOverride,
  getChannelVoiceParticipants,
  isParticipantDeafened,
  isParticipantMuted,
} from '#/features/sync/voice-selectors'
import type { SyncState } from '#/features/sync/types'
import type { UserVoiceState } from '#/features/sync/voice-types'

const USER_ONE = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6CH'

function participant(
  id: string,
  overrides: Partial<UserVoiceState> = {},
): UserVoiceState {
  return {
    id,
    joined_at: 1,
    self_mute: false,
    self_deaf: false,
    server_muted: false,
    server_deafened: false,
    camera: false,
    screensharing: false,
    version: 1,
    ...overrides,
  }
}

describe('voice participant flags', () => {
  it('combines self and server mute/deafen flags', () => {
    expect(isParticipantMuted(participant(USER_ONE, { self_mute: true }))).toBe(
      true,
    )
    expect(
      isParticipantMuted(participant(USER_ONE, { server_muted: true })),
    ).toBe(true)
    expect(
      isParticipantDeafened(participant(USER_ONE, { self_deaf: true })),
    ).toBe(true)
  })
})

describe('applyLocalVoiceSessionOverride', () => {
  it('aligns local row with user panel', () => {
    const merged = applyLocalVoiceSessionOverride(
      [participant(USER_ONE, { self_mute: true })],
      { userId: USER_ONE, micEnabled: true, deafened: false },
    )
    expect(merged[0]?.self_mute).toBe(false)
    expect(merged[0]?.self_deaf).toBe(false)
  })

  it('applies deafen override from user panel', () => {
    const merged = applyLocalVoiceSessionOverride(
      [participant(USER_ONE)],
      { userId: USER_ONE, micEnabled: false, deafened: true },
    )
    expect(merged[0]?.self_deaf).toBe(true)
    expect(merged[0]?.self_mute).toBe(true)
  })

  it('adds the local participant before the server echo arrives', () => {
    const merged = applyLocalVoiceSessionOverride([], {
      userId: USER_ONE,
      micEnabled: true,
      deafened: false,
    })

    expect(merged).toEqual([
      participant(USER_ONE, {
        joined_at: 0,
        version: 0,
      }),
    ])
  })
})

function buildState(
  participants: UserVoiceState[],
): Pick<SyncState, 'voiceParticipants' | 'users'> {
  const users: SyncState['users'] = {}
  for (const item of participants) {
    users[item.id] = { _id: item.id } as SyncState['users'][string]
  }
  return {
    users,
    voiceParticipants: {
      [CHANNEL_ID]: Object.fromEntries(
        participants.map((item) => [item.id, item]),
      ),
    },
  }
}

describe('getChannelVoiceParticipants ordering', () => {
  it('lists participants sharing their screen before the rest', () => {
    const first = participant(
      '01KT7DEM3B0T4B0BXGBXWDJ6A1',
      { joined_at: 1 },
    )
    const sharer = participant(
      '01KT7DEM3B0T4B0BXGBXWDJ6A2',
      { joined_at: 10, screensharing: true },
    )
    const last = participant(
      '01KT7DEM3B0T4B0BXGBXWDJ6A3',
      { joined_at: 5 },
    )

    const result = getChannelVoiceParticipants(
      buildState([first, sharer, last]) as SyncState,
      CHANNEL_ID,
    )

    expect(result.map((item) => item.id)).toEqual([sharer.id, first.id, last.id])
  })

  it('keeps joined_at order among participants with the same screen-share state', () => {
    const first = participant(
      '01KT7DEM3B0T4B0BXGBXWDJ6B1',
      { joined_at: 2, screensharing: true },
    )
    const second = participant(
      '01KT7DEM3B0T4B0BXGBXWDJ6B2',
      { joined_at: 7, screensharing: true },
    )

    const result = getChannelVoiceParticipants(
      buildState([second, first]) as SyncState,
      CHANNEL_ID,
    )

    expect(result.map((item) => item.id)).toEqual([first.id, second.id])
  })
})
