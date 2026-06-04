import { describe, expect, it } from 'vitest'

import {
  mergeVoiceStatesFromReady,
  normalizeUserVoiceState,
  parseVoiceFlag,
} from '#/features/sync/voice-event-utils'
import type { UserVoiceState } from '#/features/sync/voice-types'

const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const USER_TWO = '01KT7DEM3B0T4B0BXGBXWDJ6AE'
const CHANNEL_TWO = '01KT7DEM3B0T4B0BXGBXWDJ6AF'

function participant(id: string): UserVoiceState {
  return {
    id,
    joined_at: 1,
    is_publishing: true,
    is_receiving: true,
    camera: false,
    screensharing: false,
  }
}

describe('mergeVoiceStatesFromReady', () => {
  it('does not wipe existing channels when Ready sends an empty list', () => {
    const existing = {
      ch1: { [USER_ID]: participant(USER_ID) },
    }

    expect(mergeVoiceStatesFromReady(existing, [])).toEqual(existing)
  })

  it('merges updated channel maps from Ready', () => {
    const existing = {
      ch1: { u1: participant('u1') },
    }

    const merged = mergeVoiceStatesFromReady(existing, [
      { id: CHANNEL_TWO, participants: [participant(USER_TWO)] },
    ])

    expect(merged.ch1).toEqual(existing.ch1)
    expect(merged[CHANNEL_TWO]?.[USER_TWO]?.id).toBe(USER_TWO)
  })
})

describe('normalizeUserVoiceState', () => {
  it('accepts user_id and string participant ids', () => {
    expect(
      normalizeUserVoiceState({ user_id: USER_ID })?.id,
    ).toBe(USER_ID)
    expect(normalizeUserVoiceState({ id: USER_ID })?.id).toBe(USER_ID)
  })

  it('parses numeric and string voice flags', () => {
    expect(
      normalizeUserVoiceState({ id: USER_ID, is_publishing: 0 })?.is_publishing,
    ).toBe(false)
    expect(
      normalizeUserVoiceState({ id: USER_ID, is_publishing: 1 })?.is_publishing,
    ).toBe(true)
    expect(parseVoiceFlag('false', true)).toBe(false)
  })
})
