import { describe, expect, it, vi } from 'vitest'

import {
  isLiveKitTokenFailure,
  liveKitTokenExpMs,
  shouldRefreshLiveKitToken,
} from '#/features/voice/voice-token-helpers'

function tokenWithPayload(payload: object) {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${encoded}.signature`
}

describe('voice token helpers', () => {
  it('reads JWT exp as milliseconds', () => {
    expect(liveKitTokenExpMs(tokenWithPayload({ exp: 123 }))).toBe(123_000)
  })

  it('returns null for malformed tokens', () => {
    expect(liveKitTokenExpMs('not-a-jwt')).toBeNull()
  })

  it('refreshes missing or soon-expiring native credentials', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    expect(
      shouldRefreshLiveKitToken({
        url: 'wss://livekit.example',
        token: tokenWithPayload({ exp: 1_010 }),
        participantIdentity: 'user-1:desktop-native:microphone',
      }),
    ).toBe(true)
  })

  it('recognizes common LiveKit token failures', () => {
    expect(isLiveKitTokenFailure(new Error('401 unauthorized'))).toBe(true)
    expect(isLiveKitTokenFailure(new Error('network offline'))).toBe(false)
    expect(isLiveKitTokenFailure('expired')).toBe(false)
  })
})
