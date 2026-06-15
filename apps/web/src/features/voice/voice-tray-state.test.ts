import { describe, expect, it } from 'vitest'
import type { DesktopTrayVoiceState } from '@syrnike13/platform'

import type { UserVoiceState } from '#/features/sync/voice-types'

import { deriveDesktopTrayVoiceState } from './voice-tray-state'

function participant(patch: Partial<UserVoiceState> = {}): UserVoiceState {
  return {
    id: 'user-1',
    joined_at: 1,
    self_mute: false,
    self_deaf: false,
    server_muted: false,
    server_deafened: false,
    camera: false,
    screensharing: false,
    version: 1,
    ...patch,
  }
}

describe('deriveDesktopTrayVoiceState', () => {
  it('uses the default icon outside voice', () => {
    expect(
      deriveDesktopTrayVoiceState({
        channelId: null,
        currentUserId: 'user-1',
        localParticipant: participant(),
        speakingUserIds: new Set(['user-1']),
      }),
    ).toBe('default')
  })

  it('uses idle while connected and not speaking', () => {
    expect(
      deriveDesktopTrayVoiceState({
        channelId: 'voice-1',
        currentUserId: 'user-1',
        localParticipant: participant(),
        speakingUserIds: new Set(),
      }),
    ).toBe('voice-idle')
  })

  it('uses speaking while the local user is speaking', () => {
    expect(
      deriveDesktopTrayVoiceState({
        channelId: 'voice-1',
        currentUserId: 'user-1',
        localParticipant: participant(),
        speakingUserIds: new Set(['user-1']),
      }),
    ).toBe('voice-speaking')
  })

  it('prioritizes muted over speaking', () => {
    expect(
      deriveDesktopTrayVoiceState({
        channelId: 'voice-1',
        currentUserId: 'user-1',
        localParticipant: participant({ self_mute: true }),
        speakingUserIds: new Set(['user-1']),
      }),
    ).toBe('voice-muted')
  })

  it('prioritizes deafened over muted and speaking', () => {
    expect(
      deriveDesktopTrayVoiceState({
        channelId: 'voice-1',
        currentUserId: 'user-1',
        localParticipant: participant({
          self_mute: true,
          self_deaf: true,
        }),
        speakingUserIds: new Set(['user-1']),
      }),
    ).toBe('voice-deafened')
  })

  it('treats server mute and server deafen as tray status blockers', () => {
    const cases: Array<[Partial<UserVoiceState>, DesktopTrayVoiceState]> = [
      [{ server_muted: true }, 'voice-muted'],
      [{ server_deafened: true }, 'voice-deafened'],
    ]

    for (const [patch, expected] of cases) {
      expect(
        deriveDesktopTrayVoiceState({
          channelId: 'voice-1',
          currentUserId: 'user-1',
          localParticipant: participant(patch),
          speakingUserIds: new Set(['user-1']),
        }),
      ).toBe(expected)
    }
  })
})
