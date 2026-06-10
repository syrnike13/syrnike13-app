import { describe, expect, it } from 'vitest'

import {
  isRemoteScreenShareSubscribed,
  isVoiceConnectedInChannel,
} from '#/features/voice/voice-watch-screen-share'

describe('isVoiceConnectedInChannel', () => {
  it('returns true only when connected in the target channel', () => {
    expect(
      isVoiceConnectedInChannel(
        { channelId: 'voice-1', status: 'connected' },
        'voice-1',
      ),
    ).toBe(true)
  })

  it('returns false while connecting or in another channel', () => {
    expect(
      isVoiceConnectedInChannel(
        { channelId: 'voice-1', status: 'connecting' },
        'voice-1',
      ),
    ).toBe(false)
    expect(
      isVoiceConnectedInChannel(
        { channelId: 'voice-2', status: 'connected' },
        'voice-1',
      ),
    ).toBe(false)
  })
})

describe('isRemoteScreenShareSubscribed', () => {
  it('tracks watched remote screen ids', () => {
    expect(
      isRemoteScreenShareSubscribed(
        'user-1:screen',
        new Set(['user-1:screen']),
      ),
    ).toBe(true)
    expect(
      isRemoteScreenShareSubscribed('user-1:screen', new Set()),
    ).toBe(false)
  })
})
