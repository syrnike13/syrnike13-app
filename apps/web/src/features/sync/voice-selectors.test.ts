import { describe, expect, it } from 'vitest'

import {
  applyLocalVoiceSessionOverride,
  mergeVoiceParticipants,
} from '#/features/sync/voice-selectors'
import type { UserVoiceState } from '#/features/sync/voice-types'

const USER_ONE = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const USER_TWO = '01KT7DEM3B0T4B0BXGBXWDJ6AE'

function participant(
  id: string,
  overrides: Partial<UserVoiceState> = {},
): UserVoiceState {
  return {
    id,
    joined_at: 1,
    is_publishing: true,
    is_receiving: true,
    server_muted: false,
    server_deafened: false,
    camera: false,
    screensharing: false,
    ...overrides,
  }
}

describe('mergeVoiceParticipants', () => {
  it('prefers liveKit snapshot over stale store for publishing', () => {
    const merged = mergeVoiceParticipants(
      [participant(USER_ONE, { is_publishing: false })],
      [participant(USER_ONE, { is_publishing: true })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.is_publishing).toBe(true)
  })

  it('keeps API deafen state for remote participants when liveKit overwrites receive', () => {
    const merged = mergeVoiceParticipants(
      [participant(USER_TWO, { is_publishing: false, is_receiving: false })],
      [participant(USER_TWO, { is_publishing: false, is_receiving: true })],
    )
    expect(merged[0]?.is_receiving).toBe(false)
  })

  it('uses live receive state for the local participant', () => {
    const merged = mergeVoiceParticipants(
      [participant(USER_ONE, { is_receiving: true })],
      [participant(USER_ONE, { is_receiving: false })],
      USER_ONE,
    )
    expect(merged[0]?.is_receiving).toBe(false)
  })

  it('uses live media state to clear stale screen share', () => {
    const merged = mergeVoiceParticipants(
      [participant(USER_ONE, { screensharing: true })],
      [participant(USER_ONE, { screensharing: false })],
      USER_ONE,
    )
    expect(merged[0]?.screensharing).toBe(false)
  })

  it('drops live participants with invalid ids', () => {
    const merged = mergeVoiceParticipants(
      [participant(USER_ONE)],
      [participant(''), participant(USER_TWO)],
      USER_ONE,
    )

    expect(merged.map((row) => row.id)).toEqual([USER_ONE, USER_TWO])
  })

  it('keeps server mute flags from the backend store when liveKit merges', () => {
    const merged = mergeVoiceParticipants(
      [participant(USER_TWO, { server_muted: true, server_deafened: true })],
      [participant(USER_TWO)],
    )

    expect(merged[0]?.server_muted).toBe(true)
    expect(merged[0]?.server_deafened).toBe(true)
  })
})

describe('applyLocalVoiceSessionOverride', () => {
  it('aligns local row with user panel', () => {
    const merged = applyLocalVoiceSessionOverride(
      [participant(USER_ONE, { is_publishing: false })],
      { userId: USER_ONE, micEnabled: true, deafened: false },
    )
    expect(merged[0]?.is_publishing).toBe(true)
    expect(merged[0]?.is_receiving).toBe(true)
  })
})
