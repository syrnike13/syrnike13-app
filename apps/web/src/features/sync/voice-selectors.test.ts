import { describe, expect, it } from 'vitest'

import {
  applyLocalVoiceSessionOverride,
  isParticipantDeafened,
  isParticipantMuted,
} from '#/features/sync/voice-selectors'
import type { UserVoiceState } from '#/features/sync/voice-types'

const USER_ONE = '01KT7DEM3B0T4B0BXGBXWDJ6AD'

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
