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
      [participant('u1', { is_publishing: false })],
      [participant('u1', { is_publishing: true })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.is_publishing).toBe(true)
  })

  it('keeps API deafen state for remote participants when liveKit overwrites receive', () => {
    const merged = mergeVoiceParticipants(
      [participant('remote', { is_publishing: false, is_receiving: false })],
      [participant('remote', { is_publishing: false, is_receiving: true })],
    )
    expect(merged[0]?.is_receiving).toBe(false)
  })

  it('uses live receive state for the local participant', () => {
    const merged = mergeVoiceParticipants(
      [participant('me', { is_receiving: true })],
      [participant('me', { is_receiving: false })],
      'me',
    )
    expect(merged[0]?.is_receiving).toBe(false)
  })

  it('uses live media state to clear stale screen share', () => {
    const merged = mergeVoiceParticipants(
      [participant('me', { screensharing: true })],
      [participant('me', { screensharing: false })],
      'me',
    )
    expect(merged[0]?.screensharing).toBe(false)
  })

  it('keeps server mute flags from the backend store when liveKit merges', () => {
    const merged = mergeVoiceParticipants(
      [participant('remote', { server_muted: true, server_deafened: true })],
      [participant('remote')],
    )

    expect(merged[0]?.server_muted).toBe(true)
    expect(merged[0]?.server_deafened).toBe(true)
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
