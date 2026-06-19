import { describe, expect, it } from 'vitest'

import { soundEventFromGatewayEvent } from './sound-event-map'

const baseContext = {
  currentUserId: 'user-self',
  activeChannelId: 'channel-open',
  currentVoiceChannelId: 'voice-open',
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

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          _id: 'message-3',
          channel: 'channel-other',
          author: 'user-other',
          content: 'reply body',
          mentions: ['user-self'],
        },
        baseContext,
      ),
    ).toBe('message.mention')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'Message',
          _id: 'message-4',
          channel: 'channel-other',
          author: 'user-other',
          content: 'reply body',
          mentions: ['user-someone-else'],
        },
        baseContext,
      ),
    ).toBe('message.default')
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
          type: 'VoiceCallActive',
          channel_id: 'voice-open',
          initiator_id: 'user-other',
        },
        baseContext,
      ),
    ).toBe('call.connected')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallEnd',
          channel_id: 'voice-open',
        },
        baseContext,
      ),
    ).toBe('call.ended')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-open',
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
          channel_id: 'voice-open',
          state: { id: 'user-other', screensharing: true },
          previous_state: { screensharing: false },
        },
        baseContext,
      ),
    ).toBe('screen_share.started')
  })

  it('plays remote screen share sounds only for the current voice channel', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-other',
          state: { id: 'user-other', screensharing: true },
          previous_state: { screensharing: false },
        },
        baseContext,
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: { id: 'user-other', screensharing: true },
          previous_state: { screensharing: false },
        },
        { ...baseContext, currentVoiceChannelId: null },
      ),
    ).toBeNull()
  })

  it('plays participant join, leave, and move sounds only for the current voice channel', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceChannelJoin',
          id: 'voice-other',
          state: { id: 'user-other' },
        },
        baseContext,
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceChannelLeave',
          id: 'voice-open',
          user: 'user-other',
        },
        baseContext,
      ),
    ).toBe('voice.user_leave')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceChannelMove',
          user: 'user-other',
          from: 'voice-other',
          to: 'voice-open',
        },
        baseContext,
      ),
    ).toBe('voice.user_move')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceChannelMove',
          user: 'user-other',
          from: 'voice-away',
          to: 'voice-other',
        },
        baseContext,
      ),
    ).toBeNull()
  })

  it('plays call connected and ended sounds only for the current voice participant', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallActive',
          channel_id: 'voice-other',
          initiator_id: 'user-other',
        },
        baseContext,
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallActive',
          channel_id: 'voice-open',
          initiator_id: 'user-other',
          declined_recipients: ['user-self'],
        },
        baseContext,
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallEnd',
          channel_id: 'voice-other',
        },
        baseContext,
      ),
    ).toBeNull()
  })

  it('uses the known previous voice media state when gateway omits previous_state', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: { id: 'user-other', screensharing: true },
        },
        {
          ...baseContext,
          previousVoiceState: { screensharing: false, camera: false },
        },
      ),
    ).toBe('screen_share.started')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: { id: 'user-other', screensharing: true },
        },
        {
          ...baseContext,
          previousVoiceState: { screensharing: true, camera: false },
        },
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: { id: 'user-other', camera: true },
        },
        baseContext,
      ),
    ).toBeNull()
  })

  it('does not turn remote mute or deafen updates into shared button sounds', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: { id: 'user-other', self_mute: true },
          previous_state: { self_mute: false },
        },
        baseContext,
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: { id: 'user-other', self_deaf: true },
          previous_state: { self_deaf: false },
        },
        baseContext,
      ),
    ).toBeNull()
  })
})
