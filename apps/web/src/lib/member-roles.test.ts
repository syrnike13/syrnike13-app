import { describe, expect, it } from 'vitest'
import type { Member, Role, Server } from '@syrnike13/api-types'

import { canToggleMemberRole } from '#/lib/member-roles'
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
})
