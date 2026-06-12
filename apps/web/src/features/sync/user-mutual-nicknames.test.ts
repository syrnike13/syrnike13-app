import type { Member, Server, User } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import type { SyncState } from '#/features/sync/types'

import { listUserMutualServerNicknames } from './selectors'

const CURRENT_USER_ID = 'current-user'
const TARGET_USER_ID = 'target-user'

function user(id: string, username = id): User {
  return {
    _id: id,
    username,
    discriminator: '0001',
    relationship: id === CURRENT_USER_ID ? 'User' : 'Friend',
    online: true,
  } as User
}

function server(id: string, name: string): Server {
  return {
    _id: id,
    name,
    owner: CURRENT_USER_ID,
    default_permissions: 0,
  } as Server
}

function member(
  serverId: string,
  userId: string,
  nickname?: string | null,
): Member {
  return {
    _id: {
      server: serverId,
      user: userId,
    },
    nickname,
  } as Member
}

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    ready: true,
    selectedServerId: null,
    servers: {},
    channels: {},
    users: {
      [CURRENT_USER_ID]: user(CURRENT_USER_ID, 'me'),
      [TARGET_USER_ID]: user(TARGET_USER_ID, 'test_isa'),
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

describe('listUserMutualServerNicknames', () => {
  it('returns unique target nicknames from mutual servers only', () => {
    const syncState = state({
      servers: {
        'server-a': server('server-a', 'Alpha'),
        'server-b': server('server-b', 'Beta'),
        'server-c': server('server-c', 'Gamma'),
      },
      members: {
        'server-a:current-user': member('server-a', CURRENT_USER_ID),
        'server-a:target-user': member('server-a', TARGET_USER_ID, 'Хан батый'),
        'server-b:current-user': member('server-b', CURRENT_USER_ID),
        'server-b:target-user': member('server-b', TARGET_USER_ID, 'Андрей'),
        'server-c:target-user': member('server-c', TARGET_USER_ID, 'Не общий'),
      },
    })

    expect(
      listUserMutualServerNicknames(
        syncState,
        TARGET_USER_ID,
        CURRENT_USER_ID,
      ),
    ).toEqual(['Хан батый', 'Андрей'])
  })

  it('skips empty nicknames and names equal to the global user name', () => {
    const syncState = state({
      users: {
        [CURRENT_USER_ID]: user(CURRENT_USER_ID, 'me'),
        [TARGET_USER_ID]: user(TARGET_USER_ID, 'test_isa'),
      },
      servers: {
        'server-a': server('server-a', 'Alpha'),
        'server-b': server('server-b', 'Beta'),
      },
      members: {
        'server-a:current-user': member('server-a', CURRENT_USER_ID),
        'server-a:target-user': member('server-a', TARGET_USER_ID, 'test_isa'),
        'server-b:current-user': member('server-b', CURRENT_USER_ID),
        'server-b:target-user': member('server-b', TARGET_USER_ID, '  '),
      },
    })

    expect(
      listUserMutualServerNicknames(
        syncState,
        TARGET_USER_ID,
        CURRENT_USER_ID,
      ),
    ).toEqual([])
  })
})
