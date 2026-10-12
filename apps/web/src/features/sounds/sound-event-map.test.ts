import { describe, expect, it } from 'vitest'
import type { UserVoiceState } from '@syrnike13/api-types/gateway-schema'

import { soundEventFromGatewayEvent } from './sound-event-map'

const baseContext = {
  currentUserId: 'user-self',
  activeChannelId: 'channel-open',
  currentVoiceChannelId: 'voice-open',
  documentFocused: false,
  blockedUserIds: new Set<string>(),
}

function voiceState(
  id: string,
  overrides: Partial<UserVoiceState> = {},
): UserVoiceState {
  return {
    id,
    joined_at: 1,
    self_mute: false,
    self_deaf: false,
    server_muted: false,
    server_deafened: false,
    screensharing: false,
    camera: false,
    version: 1,
    ...overrides,
  }
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
          _id: 'message-self',
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
          _id: 'message-blocked',
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
          _id: 'message-focused',
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
          channel_id: 'voice-open',
          initiator_id: 'user-other',
          started_at: 1,
          expires_at: 2,
          recipients: ['user-self'],
          declined_recipients: [],
        },
        baseContext,
      ),
    ).toBe('call.incoming_ring')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceCallRinging',
          channel_id: 'voice-open',
          initiator_id: 'user-self',
          started_at: 1,
          expires_at: 2,
          recipients: [],
          declined_recipients: [],
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
          started_at: 1,
          declined_recipients: [],
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
          state: voiceState('user-other'),
        },
        baseContext,
      ),
    ).toBe('voice.user_join')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'MessageReact',
          id: 'message-1',
          channel_id: 'channel-1',
          user_id: 'user-other',
          emoji_id: 'emoji-1',
        },
        baseContext,
      ),
    ).toBe('message.reaction')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: voiceState('user-other', { screensharing: true }),
        },
        {
          ...baseContext,
          previousVoiceState: { screensharing: false, camera: false },
        },
      ),
    ).toBe('screen_share.started')
  })

  it('plays remote screen share sounds only for the current voice channel', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-other',
          state: voiceState('user-other', { screensharing: true }),
        },
        {
          ...baseContext,
          previousVoiceState: { screensharing: false, camera: false },
        },
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: voiceState('user-other', { screensharing: true }),
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
          state: voiceState('user-other'),
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
          state: voiceState('user-other'),
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
          state: voiceState('user-other'),
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
          started_at: 1,
          declined_recipients: [],
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
          started_at: 1,
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
          state: voiceState('user-other', { screensharing: true }),
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
          state: voiceState('user-other', { screensharing: true }),
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
          state: voiceState('user-other', { camera: true }),
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
          state: voiceState('user-other', { self_mute: true }),
        },
        {
          ...baseContext,
          previousVoiceState: {
            screensharing: false,
            camera: false,
            selfMuted: false,
          },
        },
      ),
    ).toBeNull()

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: voiceState('user-other', { self_deaf: true }),
        },
        {
          ...baseContext,
          previousVoiceState: {
            screensharing: false,
            camera: false,
            selfDeafened: false,
          },
        },
      ),
    ).toBeNull()
  })

  it('plays mute and deafen sounds only for confirmed self voice updates', () => {
    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: voiceState('user-self', { self_mute: true }),
        },
        {
          ...baseContext,
          previousVoiceState: {
            screensharing: false,
            camera: false,
            selfMuted: false,
          },
        },
      ),
    ).toBe('voice.mute')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-open',
          state: voiceState('user-self', { self_deaf: false }),
        },
        {
          ...baseContext,
          previousVoiceState: {
            screensharing: false,
            camera: false,
            selfDeafened: true,
          },
        },
      ),
    ).toBe('voice.undeafen')

    expect(
      soundEventFromGatewayEvent(
        {
          type: 'VoiceStateUpdate',
          channel_id: 'voice-other',
          state: voiceState('user-self', { self_mute: true }),
        },
        baseContext,
      ),
    ).toBeNull()
  })
})
