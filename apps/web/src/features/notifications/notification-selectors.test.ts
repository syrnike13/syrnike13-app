import type { Channel, User } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import type { ChannelUnreadState, SyncState } from '#/features/sync/types'

import {
  selectChannelNotificationBadge,
  selectFriendRequestNotificationBadge,
  selectHomeNotificationBadge,
  selectServerNotificationBadge,
} from './notification-selectors'

const CURRENT_USER_ID = 'current-user'

function user(
  id: string,
  relationship: User['relationship'] = 'Friend',
): User {
  return {
    _id: id,
    username: id,
    discriminator: '0001',
    relationship,
    online: true,
  } as User
}

function dmChannel(
  id: string,
  otherUserId: string,
  lastMessageId: string | null = null,
): Channel {
  return {
    _id: id,
    channel_type: 'DirectMessage',
    active: true,
    recipients: [CURRENT_USER_ID, otherUserId],
    last_message_id: lastMessageId,
  } as Channel
}

function serverChannel(
  id: string,
  serverId: string,
  lastMessageId: string | null = null,
): Channel {
  return {
    _id: id,
    channel_type: 'TextChannel',
    server: serverId,
    name: id,
    last_message_id: lastMessageId,
  } as Channel
}

function unread(
  lastId: string | null,
  mentions: string[] = [],
): ChannelUnreadState {
  return { lastId, mentions }
}

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    ready: true,
    selectedServerId: null,
    servers: {},
    channels: {},
    users: {
      [CURRENT_USER_ID]: user(CURRENT_USER_ID, 'User'),
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

describe('notification selectors', () => {
  it('counts only incoming friend requests for request badges', () => {
    const syncState = state({
      users: {
        [CURRENT_USER_ID]: user(CURRENT_USER_ID, 'User'),
        'request-a': user('request-a', 'Incoming'),
        'request-b': user('request-b', 'Incoming'),
        'outgoing-a': user('outgoing-a', 'Outgoing'),
        'friend-a': user('friend-a', 'Friend'),
      },
    })

    expect(
      selectFriendRequestNotificationBadge(syncState, CURRENT_USER_ID),
    ).toEqual({
      count: 2,
      hasUnread: true,
      urgent: false,
    })
  })

  it('counts only incoming friend requests for home (unread DMs live in people rail)', () => {
    const syncState = state({
      users: {
        [CURRENT_USER_ID]: user(CURRENT_USER_ID, 'User'),
        'friend-a': user('friend-a', 'Friend'),
        'friend-b': user('friend-b', 'Friend'),
        'request-a': user('request-a', 'Incoming'),
        'request-b': user('request-b', 'Incoming'),
        'outgoing-a': user('outgoing-a', 'Outgoing'),
      },
      channels: {
        'dm-unread': dmChannel('dm-unread', 'friend-a', 'message-2'),
        'dm-read': dmChannel('dm-read', 'friend-b', 'message-2'),
        'server-unread': serverChannel(
          'server-unread',
          'server-1',
          'message-2',
        ),
      },
      unreads: {
        'dm-unread': unread('message-1'),
        'dm-read': unread('message-2'),
        'server-unread': unread('message-1'),
      },
    })

    expect(selectHomeNotificationBadge(syncState, CURRENT_USER_ID)).toEqual({
      count: 2,
      hasUnread: true,
      urgent: false,
    })
  })

  it('keeps personal channel notifications out of the home badge', () => {
    const syncState = state({
      users: {
        [CURRENT_USER_ID]: user(CURRENT_USER_ID, 'User'),
        'friend-a': user('friend-a', 'Friend'),
        'friend-b': user('friend-b', 'Friend'),
        'request-a': user('request-a', 'Incoming'),
      },
      channels: {
        'dm-mention': dmChannel('dm-mention', 'friend-a', 'message-3'),
        'dm-unread': dmChannel('dm-unread', 'friend-b', 'message-2'),
      },
      unreads: {
        'dm-mention': unread('message-3', ['message-2', 'message-3']),
        'dm-unread': unread('message-1'),
      },
    })

    expect(selectHomeNotificationBadge(syncState, CURRENT_USER_ID)).toEqual({
      count: 1,
      hasUnread: true,
      urgent: false,
    })
  })

  it('counts unread server channels for a server badge', () => {
    const syncState = state({
      servers: {
        'server-1': {
          _id: 'server-1',
          name: 'Server One',
          owner: CURRENT_USER_ID,
          channels: ['read', 'unread-a', 'unread-b'],
          default_permissions: 0,
        },
      },
      channels: {
        read: serverChannel('read', 'server-1', 'message-2'),
        'unread-a': serverChannel('unread-a', 'server-1', 'message-2'),
        'unread-b': serverChannel('unread-b', 'server-1', 'message-3'),
        'other-server-unread': serverChannel(
          'other-server-unread',
          'server-2',
          'message-2',
        ),
      },
      unreads: {
        read: unread('message-2'),
        'unread-a': unread('message-1'),
        'unread-b': unread(null),
        'other-server-unread': unread(null),
      },
    })

    expect(
      selectServerNotificationBadge(syncState, 'server-1', CURRENT_USER_ID),
    ).toEqual({
      count: 2,
      hasUnread: true,
      urgent: false,
    })
  })

  it('marks server badges urgent when visible channels contain mentions', () => {
    const syncState = state({
      servers: {
        'server-1': {
          _id: 'server-1',
          name: 'Server One',
          owner: CURRENT_USER_ID,
          channels: ['mention-a', 'mention-b', 'unread'],
          default_permissions: 0,
        },
      },
      channels: {
        'mention-a': serverChannel('mention-a', 'server-1', 'message-2'),
        'mention-b': serverChannel('mention-b', 'server-1', 'message-3'),
        unread: serverChannel('unread', 'server-1', 'message-4'),
      },
      unreads: {
        'mention-a': unread('message-1', ['message-2']),
        'mention-b': unread('message-1', ['message-2', 'message-3']),
        unread: unread('message-1'),
      },
    })

    expect(
      selectServerNotificationBadge(syncState, 'server-1', CURRENT_USER_ID),
    ).toEqual({
      count: 3,
      hasUnread: true,
      urgent: true,
    })
  })

  it('returns a channel badge from unread state', () => {
    const channel = serverChannel('unread', 'server-1', 'message-2')
    const syncState = state({
      channels: {
        unread: channel,
      },
      unreads: {
        unread: unread('message-1'),
      },
    })

    expect(selectChannelNotificationBadge(syncState, channel)).toEqual({
      count: 1,
      hasUnread: true,
      urgent: false,
    })
  })

  it('returns an urgent channel badge for mention unreads', () => {
    const channel = serverChannel('mention', 'server-1', 'message-2')
    const syncState = state({
      channels: {
        mention: channel,
      },
      unreads: {
        mention: unread('message-1', ['message-2', 'message-3']),
      },
    })

    expect(selectChannelNotificationBadge(syncState, channel)).toEqual({
      count: 2,
      hasUnread: true,
      urgent: true,
    })
  })
})
