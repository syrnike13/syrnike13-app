import { describe, expect, it } from 'vitest'
import type { Member, Role, Server } from '@syrnike13/api-types'

import {
  canEditAnyMemberRole,
  canManageMemberRoles,
  canToggleMemberRole,
} from '#/lib/member-roles'
import { ChannelPermission } from '#/lib/permissions'

function makeServer(overrides: Partial<Server> = {}): Server {
  return {
    _id: 'server-1',
    owner: 'owner-1',
    name: 'Test',
    channels: [],
    default_permissions: 0,
    ...overrides,
  }
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    _id: { server: 'server-1', user: 'user-1' },
    joined_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    _id: 'role-1',
    name: 'Role',
    permissions: { a: 0, d: 0 },
    mentionable: false,
    rank: 5,
    ...overrides,
  }
}

describe('canToggleMemberRole', () => {
  it('does not let members remove their own role without assignment permission', () => {
    const role = makeRole({ rank: 5 })
    const server = makeServer({
      roles: {
        high: makeRole({ _id: 'high', name: 'High', rank: 1 }),
        [role._id]: role,
      },
    })
    const actor = makeMember({ roles: ['high', role._id] })

    expect(canToggleMemberRole(server, actor, 'user-1', actor, role, false)).toBe(
      false,
    )
  })

  it('lets members remove their own lower role with assignment permission', () => {
    const role = makeRole({ rank: 5 })
    const server = makeServer({
      roles: {
        high: makeRole({
          _id: 'high',
          name: 'High',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 1,
        }),
        [role._id]: role,
      },
    })
    const actor = makeMember({ roles: ['high', role._id] })

    expect(canToggleMemberRole(server, actor, 'user-1', actor, role, false)).toBe(
      true,
    )
  })

  it('does not let members remove their own top role with assignment permission', () => {
    const role = makeRole({
      permissions: { a: ChannelPermission.AssignRoles, d: 0 },
      rank: 1,
    })
    const server = makeServer({
      roles: {
        [role._id]: role,
        lower: makeRole({ _id: 'lower', name: 'Lower', rank: 5 }),
      },
    })
    const actor = makeMember({ roles: [role._id] })

    expect(canToggleMemberRole(server, actor, 'user-1', actor, role, false)).toBe(
      false,
    )
  })

  it('does not let members assign roles at their own rank', () => {
    const peerRole = makeRole({ _id: 'peer', name: 'Peer', rank: 1 })
    const server = makeServer({
      roles: {
        high: makeRole({
          _id: 'high',
          name: 'High',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 1,
        }),
        [peerRole._id]: peerRole,
      },
    })
    const actor = makeMember({ roles: ['high'] })
    const target = makeMember({ _id: { server: 'server-1', user: 'target-1' } })

    expect(
      canToggleMemberRole(server, actor, 'user-1', target, peerRole, true),
    ).toBe(false)
  })
})

describe('member role edit affordances', () => {
  it('opens role editing when at least one lower role can be toggled', () => {
    const lowerRole = makeRole({ _id: 'lower', name: 'Lower', rank: 5 })
    const server = makeServer({
      roles: {
        high: makeRole({
          _id: 'high',
          name: 'High',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 1,
        }),
        [lowerRole._id]: lowerRole,
      },
    })
    const actor = makeMember({ roles: ['high'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'target-1' },
    })

    expect(canManageMemberRoles(server, actor, 'user-1', target)).toBe(true)
    expect(canEditAnyMemberRole(server, actor, 'user-1', target)).toBe(true)
  })

  it('does not open role editing for equal-ranked targets', () => {
    const server = makeServer({
      roles: {
        actor: makeRole({
          _id: 'actor',
          name: 'Actor',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 1,
        }),
        target: makeRole({ _id: 'target', name: 'Target', rank: 1 }),
        lower: makeRole({ _id: 'lower', name: 'Lower', rank: 5 }),
      },
    })
    const actor = makeMember({ roles: ['actor'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'target-1' },
      roles: ['target'],
    })

    expect(canManageMemberRoles(server, actor, 'user-1', target)).toBe(false)
    expect(canEditAnyMemberRole(server, actor, 'user-1', target)).toBe(false)
  })
})
