import { describe, expect, it } from 'vitest'

import {
  ChannelPermission,
  calculateChannelPermissions,
  calculateServerPermissions,
  canBanServerMember,
  canEditMember,
  canInviteToChannel,
  canKickServerMember,
  getMemberRank,
  getServerMenuPermissions,
  hasChannelPermission,
} from '#/lib/permissions'
import { permissionOr } from '#/lib/permission-bits'
import type { Channel, Member, Server } from '@syrnike13/api-types'

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

function makeTextChannel(
  overrides: Partial<Extract<Channel, { channel_type: 'TextChannel' }>> = {},
): Extract<Channel, { channel_type: 'TextChannel' }> {
  return {
    _id: 'channel-1',
    channel_type: 'TextChannel',
    server: 'server-1',
    name: 'general',
    default_permissions: null,
    role_permissions: null,
    ...overrides,
  }
}

describe('calculateServerPermissions', () => {
  it('grants all safe permissions to the server owner', () => {
    const server = makeServer({ owner: 'user-1' })
    const permissions = calculateServerPermissions(
      server,
      makeMember(),
      'user-1',
    )

    expect(
      hasChannelPermission(permissions, ChannelPermission.ManageServer),
    ).toBe(true)
  })

  it('applies role overrides on top of default permissions', () => {
    const server = makeServer({
      default_permissions: 0,
      roles: {
        mod: {
          _id: 'mod',
          name: 'Mod',
          permissions: {
            a: ChannelPermission.ManageChannel,
            d: 0,
          },
        },
      },
    })
    const member = makeMember({ roles: ['mod'] })
    const permissions = calculateServerPermissions(server, member, 'user-1')

    expect(
      hasChannelPermission(permissions, ChannelPermission.ManageChannel),
    ).toBe(true)
    expect(
      hasChannelPermission(permissions, ChannelPermission.ManageServer),
    ).toBe(false)
  })
})

describe('calculateChannelPermissions', () => {
  it('does not let channel overrides restore disabled publish or receive permissions', () => {
    const server = makeServer({
      roles: {
        speaker: {
          _id: 'speaker',
          name: 'Speaker',
          permissions: { a: 0, d: 0 },
          rank: 1,
        },
      },
    })
    const channel = makeTextChannel({
      default_permissions: {
        a: permissionOr(ChannelPermission.ViewChannel, ChannelPermission.Speak),
        d: 0,
      },
      role_permissions: {
        speaker: {
          a: permissionOr(ChannelPermission.Video, ChannelPermission.Listen),
          d: 0,
        },
      },
    })
    const member = makeMember({
      roles: ['speaker'],
      can_publish: false,
      can_receive: false,
    })

    const permissions = calculateChannelPermissions(
      server,
      channel,
      member,
      'user-1',
    )

    expect(hasChannelPermission(permissions, ChannelPermission.Speak)).toBe(
      false,
    )
    expect(hasChannelPermission(permissions, ChannelPermission.Video)).toBe(
      false,
    )
    expect(hasChannelPermission(permissions, ChannelPermission.Listen)).toBe(
      false,
    )
  })
})

describe('canInviteToChannel', () => {
  it('allows invites only when the channel grants InviteOthers', () => {
    const server = makeServer()
    const member = makeMember()

    expect(
      canInviteToChannel(
        server,
        makeTextChannel({
          default_permissions: {
            a: permissionOr(
              ChannelPermission.ViewChannel,
              ChannelPermission.InviteOthers,
            ),
            d: 0,
          },
        }),
        member,
        'user-1',
      ),
    ).toBe(true)

    expect(
      canInviteToChannel(server, makeTextChannel(), member, 'user-1'),
    ).toBe(false)
  })
})

describe('getMemberRank', () => {
  it('uses the highest role position (minimum rank value)', () => {
    const server = makeServer({
      roles: {
        admin: {
          _id: 'admin',
          name: 'Admin',
          permissions: { a: 0, d: 0 },
          rank: 1,
        },
        mod: {
          _id: 'mod',
          name: 'Mod',
          permissions: { a: 0, d: 0 },
          rank: 4,
        },
      },
    })
    const member = makeMember({ roles: ['admin', 'mod'] })

    expect(getMemberRank(server, member)).toBe(1)
  })
})

describe('canEditMember', () => {
  it('requires an explicit management permission before rank-based member edits', () => {
    const server = makeServer({
      roles: {
        high: {
          _id: 'high',
          name: 'High',
          permissions: { a: 0, d: 0 },
          rank: 1,
        },
        low: {
          _id: 'low',
          name: 'Low',
          permissions: { a: 0, d: 0 },
          rank: 5,
        },
      },
    })
    const actor = makeMember({ roles: ['high'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'user-2' },
      roles: ['low'],
    })

    expect(canEditMember(server, actor, 'user-1', target)).toBe(false)
  })

  it('allows rank-based member edits with role assignment permission', () => {
    const server = makeServer({
      roles: {
        high: {
          _id: 'high',
          name: 'High',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 1,
        },
        low: {
          _id: 'low',
          name: 'Low',
          permissions: { a: 0, d: 0 },
          rank: 5,
        },
      },
    })
    const actor = makeMember({ roles: ['high'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'user-2' },
      roles: ['low'],
    })

    expect(canEditMember(server, actor, 'user-1', target)).toBe(true)
  })
})

describe('canKickServerMember', () => {
  it('requires kick permission and higher role rank than the target', () => {
    const server = makeServer({
      roles: {
        mod: {
          _id: 'mod',
          name: 'Mod',
          permissions: { a: ChannelPermission.KickMembers, d: 0 },
          rank: 2,
        },
        member: {
          _id: 'member',
          name: 'Member',
          permissions: { a: 0, d: 0 },
          rank: 5,
        },
      },
    })
    const actor = makeMember({ roles: ['mod'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'user-2' },
      roles: ['member'],
    })

    expect(canKickServerMember(server, actor, 'user-1', target)).toBe(true)
    expect(
      canKickServerMember(
        server,
        makeMember({ roles: ['member'] }),
        'user-2',
        actor,
      ),
    ).toBe(false)
  })

  it('does not allow kicking the server owner', () => {
    const server = makeServer({ owner: 'owner-1' })
    const actor = makeMember({
      roles: ['mod'],
    })
    const target = makeMember({
      _id: { server: 'server-1', user: 'owner-1' },
    })

    expect(canKickServerMember(server, actor, 'user-1', target)).toBe(false)
  })
})

describe('canBanServerMember', () => {
  it('requires ban permission', () => {
    const server = makeServer({
      roles: {
        mod: {
          _id: 'mod',
          name: 'Mod',
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 2,
        },
      },
    })
    const actor = makeMember({ roles: ['mod'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'user-2' },
    })

    expect(canBanServerMember(server, actor, 'user-1', target)).toBe(true)
    expect(
      canBanServerMember(
        server,
        makeMember(),
        'user-1',
        target,
      ),
    ).toBe(false)
  })

  it('does not allow banning the server owner', () => {
    const server = makeServer({ owner: 'owner-1' })
    const actor = makeMember({
      roles: ['mod'],
    })
    const target = makeMember({
      _id: { server: 'server-1', user: 'owner-1' },
    })

    expect(canBanServerMember(server, actor, 'user-1', target)).toBe(false)
  })

  it('requires higher role rank than the target', () => {
    const server = makeServer({
      roles: {
        mod: {
          _id: 'mod',
          name: 'Mod',
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 2,
        },
        admin: {
          _id: 'admin',
          name: 'Admin',
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 1,
        },
      },
    })
    const actor = makeMember({ roles: ['mod'] })
    const target = makeMember({
      _id: { server: 'server-1', user: 'user-2' },
      roles: ['admin'],
    })

    expect(canBanServerMember(server, actor, 'user-1', target)).toBe(false)
  })
})

describe('getServerMenuPermissions', () => {
  it('hides admin actions for members without management permissions', () => {
    const server = makeServer()
    const member = makeMember()
    const permissions = getServerMenuPermissions(server, [], member, 'user-1')

    expect(permissions).toEqual({
      invite: false,
      settings: false,
      createChannel: false,
      leave: true,
      copyId: true,
    })
  })
})
