import { describe, expect, it } from 'vitest'
import type { Member, Server, User } from '@syrnike13/api-types'

import {
  flattenMemberListSections,
  groupServerMembersForSidebar,
  memberDisplayColour,
  memberHoistRole,
} from '#/features/sync/member-list-groups'
import type { ServerMemberEntry } from '#/features/sync/selectors'

type TestRole = Omit<
  NonNullable<Server['roles']>[string],
  'mentionable'
> & {
  mentionable?: boolean
}

function makeUser(id: string, overrides: Partial<User> = {}): User {
  return {
    _id: id,
    username: id,
    online: true,
    ...overrides,
  } as User
}

function makeMember(userId: string, roles: string[] = []): Member {
  return {
    _id: { server: 'server-1', user: userId },
    joined_at: '2024-01-01T00:00:00Z',
    roles,
  }
}

function makeEntry(
  userId: string,
  options: { roles?: string[]; online?: boolean } = {},
): ServerMemberEntry {
  return {
    member: makeMember(userId, options.roles),
    user: makeUser(userId, { online: options.online ?? true }),
  }
}

function makeServer(roles: Record<string, TestRole> = {}): Server {
  const normalizedRoles = Object.fromEntries(
    Object.entries(roles).map(([id, role]) => [
      id,
      {
        mentionable: false,
        ...role,
      },
    ]),
  ) as Server['roles']

  return {
    _id: 'server-1',
    owner: 'owner-1',
    name: 'Test',
    channels: [],
    default_permissions: 0,
    roles: normalizedRoles,
  }
}

describe('memberHoistRole', () => {
  it('returns the highest hoist role by rank', () => {
    const server = makeServer({
      mod: {
        _id: 'mod',
        name: 'Moderator',
        permissions: { a: 0, d: 0 },
        hoist: true,
        rank: 1,
      },
      admin: {
        _id: 'admin',
        name: 'Admin',
        permissions: { a: 0, d: 0 },
        hoist: true,
        rank: 2,
        colour: '#ff0000',
      },
    })

    const role = memberHoistRole(server, makeMember('user-1', ['mod', 'admin']))
    expect(role?.id).toBe('admin')
  })
})

describe('memberDisplayColour', () => {
  it('uses the highest role colour', () => {
    const server = makeServer({
      low: {
        _id: 'low',
        name: 'Low',
        permissions: { a: 0, d: 0 },
        rank: 1,
        colour: '00ff00',
      },
      high: {
        _id: 'high',
        name: 'High',
        permissions: { a: 0, d: 0 },
        rank: 2,
        colour: '#112233',
      },
    })

    expect(memberDisplayColour(server, makeMember('user-1', ['low', 'high']))).toBe(
      '#112233',
    )
  })
})

describe('groupServerMembersForSidebar', () => {
  it('groups online members by hoist roles and offline members at the end', () => {
    const server = makeServer({
      admin: {
        _id: 'admin',
        name: 'Admin',
        permissions: { a: 0, d: 0 },
        hoist: true,
        rank: 2,
      },
      member: {
        _id: 'member',
        name: 'Member',
        permissions: { a: 0, d: 0 },
        hoist: true,
        rank: 1,
      },
    })

    const members = [
      makeEntry('alice', { roles: ['admin'] }),
      makeEntry('bob', { roles: ['member'] }),
      makeEntry('carol'),
      makeEntry('dave', { online: false }),
    ]

    const sections = groupServerMembersForSidebar(server, members)

    expect(sections.map((section) => section.type)).toEqual([
      'role',
      'role',
      'online',
      'offline',
    ])
    expect(sections[0]).toMatchObject({
      type: 'role',
      role: { id: 'admin' },
      members: [{ user: { _id: 'alice' } }],
    })
    expect(sections[1]).toMatchObject({
      type: 'role',
      role: { id: 'member' },
      members: [{ user: { _id: 'bob' } }],
    })
    expect(sections[2]).toMatchObject({
      type: 'online',
      members: [{ user: { _id: 'carol' } }],
    })
    expect(sections[3]).toMatchObject({
      type: 'offline',
      members: [{ user: { _id: 'dave' } }],
    })
  })

  it('places unhoisted online members before the offline group', () => {
    const server = makeServer({
      admin: {
        _id: 'admin',
        name: 'Admin',
        permissions: { a: 0, d: 0 },
        hoist: true,
        rank: 1,
      },
    })

    const members = [
      makeEntry('alice', { roles: ['admin'] }),
      makeEntry('bob'),
      makeEntry('carol', { online: false }),
    ]

    const sections = groupServerMembersForSidebar(server, members)

    expect(sections.map((section) => section.type)).toEqual([
      'role',
      'online',
      'offline',
    ])
    expect(sections[1]).toMatchObject({
      type: 'online',
      members: [{ user: { _id: 'bob' } }],
    })
  })

  it('flattens sections with stable member keys', () => {
    const server = makeServer({
      admin: {
        _id: 'admin',
        name: 'Admin',
        permissions: { a: 0, d: 0 },
        hoist: true,
        rank: 1,
      },
    })

    const members = [
      makeEntry('alice', { roles: ['admin'] }),
      makeEntry('bob'),
    ]

    const flat = flattenMemberListSections(
      groupServerMembersForSidebar(server, members),
    )

    expect(flat.filter((item) => item.kind === 'member').map((item) => item.key)).toEqual(
      ['alice', 'bob'],
    )
  })
})
