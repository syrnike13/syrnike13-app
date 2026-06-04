import { describe, expect, it } from 'vitest'

import {
  applyLocalVoiceSessionOverride,
  mergeVoiceParticipants,
} from '#/features/sync/voice-selectors'
import type { UserVoiceState } from '#/features/sync/voice-types'

function participant(
  id: string,
  overrides: Partial<UserVoiceState> = {},
): UserVoiceState {
  return {
    id,
    joined_at: 1,
    is_publishing: true,
    is_receiving: true,
    camera: false,
    screensharing: false,
    ...overrides,
  }
}

describe('mergeVoiceParticipants', () => {
  it('prefers liveKit snapshot over stale store', () => {
    const merged = mergeVoiceParticipants(
      [participant('u1', { is_publishing: false })],
      [participant('u1', { is_publishing: true })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.is_publishing).toBe(true)
  })
})

describe('applyLocalVoiceSessionOverride', () => {
  it('aligns local row with user panel', () => {
    const merged = applyLocalVoiceSessionOverride(
      [participant('me', { is_publishing: false })],
      { userId: 'me', micEnabled: true, deafened: false },
    )
    expect(merged[0]?.is_publishing).toBe(true)
    expect(merged[0]?.is_receiving).toBe(true)
  })
})
