import type { Channel, Member, Role, Server, User } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import { buildMentionSuggestionItems } from '#/components/chat/message-composer-mentions'
import { permissionOr } from '#/lib/permission-bits'
import { ChannelPermission } from '#/lib/permissions'

const CURRENT_USER_ID = '01JMENTIONCURRENT000001'
const USER_ID = '01JMENTIONTARGET0000001'
const ROLE_MENTIONABLE_ID = '01JMENTIONROLE00000001'
const ROLE_PROTECTED_ID = '01JMENTIONROLE00000002'

function makeUser(id: string, username: string): User {
  return {
    _id: id,
    username,
    online: true,
  } as User
}

function makeMember(userId: string, roles: string[] = []): Member {
  return {
    _id: { server: 'server-1', user: userId },
    joined_at: '2024-01-01T00:00:00Z',
    roles,
  }
}

function makeRole(overrides: Partial<Role>): Role {
  return {
    _id: 'role-1',
    name: 'Role',
    permissions: { a: 0, d: 0 },
    mentionable: false,
    rank: 0,
    ...overrides,
  }
}

function makeServer(defaultPermissions = ChannelPermission.ViewChannel): Server {
  return {
    _id: 'server-1',
    owner: 'owner-1',
    name: 'Server',
    channels: ['channel-1'],
    default_permissions: defaultPermissions,
    roles: {
      [ROLE_MENTIONABLE_ID]: makeRole({
        _id: ROLE_MENTIONABLE_ID,
        name: 'Raiders',
        colour: '#ff5500',
        mentionable: true,
        rank: 2,
      }),
      [ROLE_PROTECTED_ID]: makeRole({
        _id: ROLE_PROTECTED_ID,
        name: 'Admins',
        mentionable: false,
        rank: 3,
      }),
    },
  }
}

function makeChannel(): Extract<Channel, { channel_type: 'TextChannel' }> {
  return {
    _id: 'channel-1',
    channel_type: 'TextChannel',
    server: 'server-1',
    name: 'general',
    default_permissions: null,
  }
}

const users = {
  [CURRENT_USER_ID]: makeUser(CURRENT_USER_ID, 'current'),
  [USER_ID]: makeUser(USER_ID, 'maria'),
}

const members = {
  [`server-1:${CURRENT_USER_ID}`]: makeMember(CURRENT_USER_ID),
  [`server-1:${USER_ID}`]: makeMember(USER_ID),
}

describe('buildMentionSuggestionItems', () => {
  it('suggests mentionable roles without privileged mention permissions', () => {
    const items = buildMentionSuggestionItems({
      query: '',
      channel: makeChannel(),
      users,
      members,
      server: makeServer(),
      currentUserId: CURRENT_USER_ID,
    })

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'role',
          id: ROLE_MENTIONABLE_ID,
          label: '@Raiders',
          colour: '#ff5500',
        }),
        expect.objectContaining({
          kind: 'user',
          id: USER_ID,
        }),
      ]),
    )
    expect(items.some((item) => item.kind === 'everyone')).toBe(false)
    expect(items.some((item) => item.kind === 'online')).toBe(false)
    expect(
      items.some(
        (item) => item.kind === 'role' && item.id === ROLE_PROTECTED_ID,
      ),
    ).toBe(false)
  })

  it('suggests protected roles and mass mentions with matching permissions', () => {
    const permissions = permissionOr(
      ChannelPermission.ViewChannel,
      permissionOr(
        ChannelPermission.MentionRoles,
        ChannelPermission.MentionEveryone,
      ),
    )

    const items = buildMentionSuggestionItems({
      query: '',
      channel: makeChannel(),
      users,
      members,
      server: makeServer(permissions),
      currentUserId: CURRENT_USER_ID,
    })

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'everyone' }),
        expect.objectContaining({ kind: 'online' }),
        expect.objectContaining({
          kind: 'role',
          id: ROLE_PROTECTED_ID,
          label: '@Admins',
        }),
      ]),
    )
  })

  it('filters role suggestions by role name', () => {
    const items = buildMentionSuggestionItems({
      query: 'raid',
      channel: makeChannel(),
      users,
      members,
      server: makeServer(),
      currentUserId: CURRENT_USER_ID,
    })

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'role',
        id: ROLE_MENTIONABLE_ID,
      }),
    ])
  })

  it('orders role suggestions by highest hierarchy first', () => {
    const items = buildMentionSuggestionItems({
      query: '',
      channel: makeChannel(),
      users,
      members,
      server: makeServer(
        permissionOr(
          ChannelPermission.ViewChannel,
          ChannelPermission.MentionRoles,
        ),
      ),
      currentUserId: CURRENT_USER_ID,
    })

    expect(
      items
        .filter((item) => item.kind === 'role')
        .map((item) => item.id),
    ).toEqual([ROLE_MENTIONABLE_ID, ROLE_PROTECTED_ID])
  })
})
