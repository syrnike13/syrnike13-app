import { describe, expect, it, vi } from 'vitest'

import {
  rememberCanceledVoiceOperation,
  resetLocalVoiceEventGuard,
  setLocalVoiceEventUserId,
  shouldIgnoreVoiceGatewayEvent,
} from './voice-local-event-guard'

describe('local voice event guard', () => {
  it('ignores self voice join and move events without operation id', () => {
    resetLocalVoiceEventGuard()
    setLocalVoiceEventUserId('user-a')

    expect(
      shouldIgnoreVoiceGatewayEvent({
        type: 'VoiceChannelJoin',
        id: 'voice-b',
        state: { id: 'user-a' },
      }),
    ).toBe(true)
    expect(
      shouldIgnoreVoiceGatewayEvent({
        type: 'VoiceChannelMove',
        user: 'user-a',
        from: 'voice-a',
        to: 'voice-b',
        state: { id: 'user-a' },
      }),
    ).toBe(true)
  })

  it('does not ignore remote voice join without operation id', () => {
    resetLocalVoiceEventGuard()
    setLocalVoiceEventUserId('user-a')

    expect(
      shouldIgnoreVoiceGatewayEvent({
        type: 'VoiceChannelJoin',
        id: 'voice-b',
        state: { id: 'user-b' },
      }),
    ).toBe(false)
  })

  it('ignores self join and move events for canceled operations for 30 seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    try {
      resetLocalVoiceEventGuard()
      setLocalVoiceEventUserId('user-a')
      rememberCanceledVoiceOperation('op-b')

      expect(
        shouldIgnoreVoiceGatewayEvent({
          type: 'VoiceChannelMove',
          user: 'user-a',
          from: 'voice-a',
          to: 'voice-b',
          operation_id: 'op-b',
          state: { id: 'user-a' },
        }),
      ).toBe(true)

      vi.setSystemTime(31_001)

      expect(
        shouldIgnoreVoiceGatewayEvent({
          type: 'VoiceChannelMove',
          user: 'user-a',
          from: 'voice-a',
          to: 'voice-b',
          operation_id: 'op-b',
          state: { id: 'user-a' },
        }),
      ).toBe(false)
    } finally {
      resetLocalVoiceEventGuard()
      vi.useRealTimers()
    }
  })

  it('does not let a canceled operation block a newer explicit operation', () => {
    resetLocalVoiceEventGuard()
    setLocalVoiceEventUserId('user-a')
    rememberCanceledVoiceOperation('op-b')

    expect(
      shouldIgnoreVoiceGatewayEvent({
        type: 'VoiceChannelJoin',
        id: 'voice-c',
        operation_id: 'op-c',
        state: { id: 'user-a' },
      }),
    ).toBe(false)
  })
})
