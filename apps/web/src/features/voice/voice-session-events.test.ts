import { describe, expect, it } from 'vitest'

import { voiceCommitFromGatewayEvent } from './voice-session-events'

describe('voice session gateway events', () => {
  it('returns the committed channel when the local user joins voice', () => {
    const commit = voiceCommitFromGatewayEvent(
      {
        type: 'VoiceChannelJoin',
        id: 'voice-a',
        state: { id: 'user-a' },
      },
      'user-a',
    )

    expect(commit).toEqual({ channelId: 'voice-a' })
  })

  it('returns the target channel when the local user moves voice channels', () => {
    const commit = voiceCommitFromGatewayEvent(
      {
        type: 'VoiceChannelMove',
        user: 'user-a',
        from: 'voice-a',
        to: 'voice-b',
        state: { id: 'user-a' },
      },
      'user-a',
    )

    expect(commit).toEqual({ channelId: 'voice-b' })
  })

  it('ignores voice commits for other users', () => {
    expect(
      voiceCommitFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-a',
          state: { id: 'user-b' },
        },
        'user-a',
      ),
    ).toBeNull()

    expect(
      voiceCommitFromGatewayEvent(
        {
          type: 'VoiceChannelMove',
          user: 'user-b',
          from: 'voice-a',
          to: 'voice-b',
          state: { id: 'user-b' },
        },
        'user-a',
      ),
    ).toBeNull()
  })
})
