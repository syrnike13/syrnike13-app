import { describe, expect, it } from 'vitest'

import {
  mergeVoiceStatesFromReady,
  normalizeUserVoiceState,
  parseVoiceFlag,
  shouldApplyVoiceState,
} from '#/features/sync/voice-event-utils'
import type { UserVoiceState } from '#/features/sync/voice-types'

const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const USER_TWO = '01KT7DEM3B0T4B0BXGBXWDJ6AE'
const CHANNEL_TWO = '01KT7DEM3B0T4B0BXGBXWDJ6AF'

function participant(id: string, version = 1): UserVoiceState {
  return {
    id,
    joined_at: 1,
    self_mute: false,
    self_deaf: false,
    server_muted: false,
    server_deafened: false,
    camera: false,
    screensharing: false,
    version,
  }
}

describe('mergeVoiceStatesFromReady', () => {
  it('replaces existing channels when Ready sends an empty list', () => {
    const existing = {
      ch1: { [USER_ID]: participant(USER_ID) },
    }

    expect(mergeVoiceStatesFromReady(existing, [])).toEqual({})
  })

  it('replaces channel maps from Ready', () => {
    const existing = {
      ch1: { u1: participant('u1') },
    }

    const merged = mergeVoiceStatesFromReady(existing, [
      { id: CHANNEL_TWO, participants: [participant(USER_TWO)] },
    ])

    expect(merged.ch1).toBeUndefined()
    expect(merged[CHANNEL_TWO]?.[USER_TWO]?.id).toBe(USER_TWO)
  })
})

describe('normalizeUserVoiceState', () => {
  it('accepts user_id and string participant ids', () => {
    expect(normalizeUserVoiceState({ user_id: USER_ID })?.id).toBe(USER_ID)
    expect(normalizeUserVoiceState({ id: USER_ID })?.id).toBe(USER_ID)
  })

  it('parses self_mute/self_deaf flags', () => {
    expect(
      normalizeUserVoiceState({ id: USER_ID, self_mute: 0 })?.self_mute,
    ).toBe(false)
    expect(
      normalizeUserVoiceState({ id: USER_ID, self_mute: 'true' })?.self_mute,
    ).toBe(true)
    expect(
      normalizeUserVoiceState({ id: USER_ID, self_deaf: 1 })?.self_deaf,
    ).toBe(true)
    expect(parseVoiceFlag('false', true)).toBe(false)
  })

  it('defaults server mute flags to false and parses explicit values', () => {
    expect(normalizeUserVoiceState({ id: USER_ID })?.server_muted).toBe(false)
    expect(
      normalizeUserVoiceState({ id: USER_ID, server_deafened: 'true' })
        ?.server_deafened,
    ).toBe(true)
  })
})

describe('shouldApplyVoiceState', () => {
  it('drops stale snapshots with lower version', () => {
    expect(
      shouldApplyVoiceState(participant(USER_ID, 3), participant(USER_ID, 2)),
    ).toBe(false)
    expect(
      shouldApplyVoiceState(participant(USER_ID, 2), participant(USER_ID, 3)),
    ).toBe(true)
  })

  it('drops snapshots with the same version and joined_at', () => {
    expect(
      shouldApplyVoiceState(participant(USER_ID, 3), participant(USER_ID, 3)),
    ).toBe(false)
  })
})
