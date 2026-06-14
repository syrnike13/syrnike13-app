import { describe, expect, it } from 'vitest'

import { soundEventFromGatewayEvent } from './sound-event-map'

const baseContext = {
  currentUserId: 'user-self',
  activeChannelId: 'channel-open',
  documentFocused: false,
  blockedUserIds: new Set<string>(),
}

describe('gateway sound event mapping', () => {
  it('maps inactive incoming messages and mentions', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          _id: 'message-1',
          channel: 'channel-other',
          author: 'user-other',
          content: 'hello',
        },
        baseContext,
      ),
    ).toBe('message.default')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          _id: 'message-2',
          channel: 'channel-other',
          author: 'user-other',
          content: '<@user-self> hello',
        },
        baseContext,
      ),
    ).toBe('message.mention')
  })

  it('ignores self messages, blocked users, and focused active channel messages', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          channel: 'channel-other',
          author: 'user-self',
        },
        baseContext,
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          channel: 'channel-other',
          author: 'blocked-user',
        },
        { ...baseContext, blockedUserIds: new Set(['blocked-user']) },
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          channel: 'channel-open',
          author: 'user-other',
        },
        { ...baseContext, documentFocused: true },
      ),
    ).toBeNull()
  })

  it('maps call, voice, reaction, and screen share gateway events', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallRinging',
          initiator_id: 'user-other',
          recipients: ['user-self'],
        },
        baseContext,
      ),
    ).toBe('call.incoming_ring')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallRinging',
          initiator_id: 'user-self',
        },
        baseContext,
      ),
    ).toBe('call.outgoing_ring')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-1',
          state: { id: 'user-other' },
        },
        baseContext,
      ),
    ).toBe('voice.user_join')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'MessageReact',
          user_id: 'user-other',
        },
        baseContext,
      ),
    ).toBe('message.reaction')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          state: { id: 'user-other', screensharing: true },
          previous_state: { screensharing: false },
        },
        baseContext,
      ),
    ).toBe('screen_share.started')
  })
})
