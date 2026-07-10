import { describe, expect, it } from 'vitest'

import { voiceIntentActionFromGatewayEvent } from './voice-intent-gateway-events'

describe('voiceIntentActionFromGatewayEvent', () => {
  it('maps a local voice join broadcast to an executor commit action', () => {
    expect(
      voiceIntentActionFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-a',
          operation_id: 'op-join-a',
          state: { id: 'user-a' },
        },
        'user-a',
      ),
    ).toEqual({
      type: 'commit',
      channelId: 'voice-a',
      operationId: 'op-join-a',
    })
  })

  it('maps a local voice move broadcast to the target channel', () => {
    expect(
      voiceIntentActionFromGatewayEvent(
        {
          type: 'VoiceChannelMove',
          user: 'user-a',
          from: 'voice-a',
          to: 'voice-b',
          operationId: 'op-move-b',
        },
        'user-a',
      ),
    ).toEqual({
      type: 'commit',
      channelId: 'voice-b',
      operationId: 'op-move-b',
    })
  })

  it('ignores commit broadcasts without operation ids', () => {
    expect(
      voiceIntentActionFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-a',
          state: { id: 'user-a' },
        },
        'user-a',
      ),
    ).toBeNull()
  })

  it('requires operation-fenced local voice leave broadcasts', () => {
    expect(
      voiceIntentActionFromGatewayEvent(
        {
          type: 'VoiceChannelLeave',
          id: 'voice-a',
          user: 'user-a',
        },
        'user-a',
      ),
    ).toBeNull()

    expect(
      voiceIntentActionFromGatewayEvent(
        {
          type: 'VoiceChannelLeave',
          id: 'voice-a',
          user: 'user-a',
          operation_id: 'op-leave-a',
        },
        'user-a',
      ),
    ).toEqual({
      type: 'leave_observed',
      operationId: 'op-leave-a',
    })
  })

  it('ignores voice broadcasts for other users', () => {
    expect(
      voiceIntentActionFromGatewayEvent(
        {
          type: 'VoiceChannelMove',
          user: 'user-b',
          from: 'voice-a',
          to: 'voice-b',
          operation_id: 'op-other',
        },
        'user-a',
      ),
    ).toBeNull()
  })
})
