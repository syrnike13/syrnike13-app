import type { Channel } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import type { ChannelUnreadState, SyncState } from '#/features/sync/types'
import { voiceCallUiKey } from './voice-call-utils'

import { listVisibleDmRailChannels } from './selectors'

const CURRENT_USER_ID = 'current-user'

function voiceParticipant(id: string) {
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
  }
}

function dmChannel(
  id: string,
  otherUserId: string,
  lastMessageId: string | null = null,
) {
  return {
    _id: id,
    channel_type: 'DirectMessage',
    active: true,
    recipients: [CURRENT_USER_ID, otherUserId],
    last_message_id: lastMessageId,
  } as Channel
}

function unreadState(
  lastId: string | null,
  mentions: string[] = [],
): ChannelUnreadState {
  return { lastId, mentions }
}

function state(
  channels: Channel[],
  overrides: Partial<SyncState> = {},
): SyncState {
  return {
    ready: true,
    authorization: { revision: 0, global: 0, servers: {}, channels: {}, users: {} },
    selectedServerId: null,
    servers: {},
    channels: Object.fromEntries(channels.map((channel) => [channel._id, channel])),
    users: {
      [CURRENT_USER_ID]: {
        _id: CURRENT_USER_ID,
        username: 'me',
        discriminator: '0001',
        relationship: 'User',
        online: true,
      },
      'friend-a': {
        _id: 'friend-a',
        username: 'alice',
        discriminator: '0002',
        relationship: 'Friend',
        online: true,
      },
      'friend-b': {
        _id: 'friend-b',
        username: 'bob',
        discriminator: '0003',
        relationship: 'Friend',
        online: true,
      },
      'friend-c': {
        _id: 'friend-c',
        username: 'charlie',
        discriminator: '0004',
        relationship: 'Friend',
        online: true,
      },
    },
    members: {},
    emojis: {},
    messages: {},
    unreads: {},
    typingUsers: {},
    voiceParticipants: {},
    voiceCalls: {},
    dismissedVoiceCallKeys: {},
    ...overrides,
  }
}

describe('listVisibleDmRailChannels', () => {
  it('hides direct messages without unread messages or current voice session', () => {
    const hidden = dmChannel('dm-hidden', 'friend-a')
    const visible = listVisibleDmRailChannels(
      state([hidden]),
      CURRENT_USER_ID,
    )

    expect(visible).toEqual([])
  })

  it('shows direct messages with unread messages', () => {
    const unread = dmChannel('dm-unread', 'friend-a', 'message-2')
    const read = dmChannel('dm-read', 'friend-b', 'message-2')

    const visible = listVisibleDmRailChannels(
      state([unread, read], {
        unreads: {
          'dm-unread': unreadState('message-1'),
          'dm-read': unreadState('message-2'),
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-unread'])
  })

  it('shows direct messages with mention unreads even after the last message is read', () => {
    const mentioned = dmChannel('dm-mentioned', 'friend-a', 'message-2')
    const read = dmChannel('dm-read', 'friend-b', 'message-2')

    const visible = listVisibleDmRailChannels(
      state([mentioned, read], {
        unreads: {
          'dm-mentioned': unreadState('message-2', ['message-2']),
          'dm-read': unreadState('message-2'),
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-mentioned'])
  })

  it('shows direct messages where the current user is in a voice session', () => {
    const inCall = dmChannel('dm-call', 'friend-a')
    const otherInCall = dmChannel('dm-other-call', 'friend-b')

    const visible = listVisibleDmRailChannels(
      state([inCall, otherInCall], {
        voiceParticipants: {
          'dm-call': {
            [CURRENT_USER_ID]: voiceParticipant(CURRENT_USER_ID),
          },
          'dm-other-call': {
            'friend-b': voiceParticipant('friend-b'),
          },
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-call'])
  })

  it('shows direct messages with an incoming voice call for the current user', () => {
    const ringing = dmChannel('dm-ringing', 'friend-a')
    const notForCurrentUser = dmChannel('dm-other-ringing', 'friend-b')

    const visible = listVisibleDmRailChannels(
      state([ringing, notForCurrentUser], {
        voiceCalls: {
          'dm-ringing': {
            channelId: 'dm-ringing',
            initiatorId: 'friend-a',
            phase: 'ringing',
            startedAt: '2026-06-12T10:00:00.000Z',
            recipients: [CURRENT_USER_ID],
            declinedRecipients: [],
          },
          'dm-other-ringing': {
            channelId: 'dm-other-ringing',
            initiatorId: 'friend-b',
            phase: 'ringing',
            startedAt: '2026-06-12T10:00:00.000Z',
            recipients: ['friend-c'],
            declinedRecipients: [],
          },
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-ringing'])
  })

  it('shows direct messages with an outgoing voice call for the current user', () => {
    const outgoing = dmChannel('dm-outgoing', 'friend-a')
    const unrelated = dmChannel('dm-idle', 'friend-b')

    const visible = listVisibleDmRailChannels(
      state([outgoing, unrelated], {
        voiceCalls: {
          'dm-outgoing': {
            channelId: 'dm-outgoing',
            initiatorId: CURRENT_USER_ID,
            phase: 'ringing',
            startedAt: '2026-06-12T10:00:00.000Z',
            recipients: ['friend-a'],
            declinedRecipients: [],
          },
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-outgoing'])
  })

  it('hides direct messages with a dismissed incoming voice call', () => {
    const ringing = dmChannel('dm-ringing', 'friend-a')
    const call = {
      channelId: 'dm-ringing',
      initiatorId: 'friend-a',
      phase: 'ringing' as const,
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: [CURRENT_USER_ID],
      declinedRecipients: [],
    }

    const visible = listVisibleDmRailChannels(
      state([ringing], {
        voiceCalls: {
          'dm-ringing': call,
        },
        dismissedVoiceCallKeys: {
          [voiceCallUiKey(call)]: true,
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible).toEqual([])
  })

  it('shows an active voice call after dismissing the same ringing call', () => {
    const activeCall = dmChannel('dm-active-call', 'friend-a')
    const startedAt = '2026-06-12T10:00:00.000Z'
    const dismissedRingingCall = {
      channelId: 'dm-active-call',
      initiatorId: 'friend-a',
      phase: 'ringing' as const,
      startedAt,
      recipients: [CURRENT_USER_ID],
      declinedRecipients: [],
    }
    const activeState = {
      ...dismissedRingingCall,
      phase: 'active' as const,
      recipients: [],
    }

    const visible = listVisibleDmRailChannels(
      state([activeCall], {
        voiceCalls: {
          'dm-active-call': activeState,
        },
        dismissedVoiceCallKeys: {
          [voiceCallUiKey(dismissedRingingCall)]: true,
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-active-call'])
  })

  it('shows direct messages with an active voice call', () => {
    const activeCall = dmChannel('dm-active-call', 'friend-a')

    const visible = listVisibleDmRailChannels(
      state([activeCall], {
        voiceCalls: {
          'dm-active-call': {
            channelId: 'dm-active-call',
            initiatorId: 'friend-a',
            phase: 'active',
            startedAt: '2026-06-12T10:00:00.000Z',
            recipients: [],
            declinedRecipients: [],
          },
        },
      }),
      CURRENT_USER_ID,
    )

    expect(visible.map((channel) => channel._id)).toEqual(['dm-active-call'])
  })
})
