import { describe, expect, it } from 'vitest'

import {
  ChannelPermission,
  calculateChannelPermissions,
  calculateServerPermissions,
  canBanServerMember,
  canEditMember,
  canInviteToChannel,
  canKickServerMember,
  canOpenServerSettings,
  canViewChannel,
  canViewServerSettingsTab,
  getMemberRank,
  getServerMenuPermissions,
  getServerSettingsAccess,
  hasChannelPermission,
  isChannelAccessRestricted,
} from '#/lib/permissions'
import { permissionOr } from '#/lib/permission-bits'
import type { Channel, Member, Role, Server } from '@syrnike13/api-types'

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
    role_permissions: undefined,
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
        mod: makeRole({
          _id: 'mod',
          name: 'Mod',
          permissions: {
            a: ChannelPermission.ManageChannel,
            d: 0,
          },
        }),
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
        speaker: makeRole({
          _id: 'speaker',
          name: 'Speaker',
          permissions: { a: 0, d: 0 },
          rank: 1,
        }),
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

describe('canViewChannel', () => {
  it('hides channels from members without ViewChannel', () => {
    const server = makeServer({
      default_permissions: permissionOr(
        ChannelPermission.ViewChannel,
        ChannelPermission.ReadMessageHistory,
      ),
    })
    const channel = makeTextChannel({
      default_permissions: {
        a: 0,
        d: ChannelPermission.ViewChannel,
      },
    })
    const member = makeMember()

    expect(canViewChannel(server, channel, member, 'user-1')).toBe(false)
    expect(canViewChannel(server, channel, member, 'owner-1')).toBe(true)
  })
})

describe('isChannelAccessRestricted', () => {
  it('marks channels where @everyone cannot view them', () => {
    const server = makeServer({
      default_permissions: permissionOr(
        ChannelPermission.ViewChannel,
        ChannelPermission.Connect,
      ),
    })
    const channel = makeTextChannel({
      voice: { max_users: null },
      default_permissions: {
        a: 0,
        d: ChannelPermission.ViewChannel,
      },
    })

    expect(isChannelAccessRestricted(server, channel)).toBe(true)
  })

  it('marks voice channels where @everyone cannot connect', () => {
    const server = makeServer({
      default_permissions: permissionOr(
        ChannelPermission.ViewChannel,
        ChannelPermission.Connect,
      ),
    })
    const channel = makeTextChannel({
      voice: { max_users: null },
      default_permissions: {
        a: 0,
        d: ChannelPermission.Connect,
      },
    })

    expect(isChannelAccessRestricted(server, channel)).toBe(true)
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
        admin: makeRole({
          _id: 'admin',
          name: 'Admin',
          permissions: { a: 0, d: 0 },
          rank: 1,
        }),
        mod: makeRole({
          _id: 'mod',
          name: 'Mod',
          permissions: { a: 0, d: 0 },
          rank: 4,
        }),
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
        high: makeRole({
          _id: 'high',
          name: 'High',
          permissions: { a: 0, d: 0 },
          rank: 1,
        }),
        low: makeRole({
          _id: 'low',
          name: 'Low',
          permissions: { a: 0, d: 0 },
          rank: 5,
        }),
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
        high: makeRole({
          _id: 'high',
          name: 'High',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 1,
        }),
        low: makeRole({
          _id: 'low',
          name: 'Low',
          permissions: { a: 0, d: 0 },
          rank: 5,
        }),
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
        mod: makeRole({
          _id: 'mod',
          name: 'Mod',
          permissions: { a: ChannelPermission.KickMembers, d: 0 },
          rank: 2,
        }),
        member: makeRole({
          _id: 'member',
          name: 'Member',
          permissions: { a: 0, d: 0 },
          rank: 5,
        }),
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
        mod: makeRole({
          _id: 'mod',
          name: 'Mod',
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 2,
        }),
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
        mod: makeRole({
          _id: 'mod',
          name: 'Mod',
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 2,
        }),
        admin: makeRole({
          _id: 'admin',
          name: 'Admin',
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 1,
        }),
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

describe('getServerSettingsAccess', () => {
  it('allows role managers to open server settings without ManageServer', () => {
    const server = makeServer({
      roles: {
        'role-1': makeRole({
          _id: 'role-1',
          permissions: { a: ChannelPermission.ManageRole, d: 0 },
          rank: 1,
        }),
      },
    })
    const member = makeMember({ roles: ['role-1'] })

    const access = getServerSettingsAccess(server, [], member, 'user-1')

    expect(canOpenServerSettings(access)).toBe(true)
    expect(canViewServerSettingsTab(access, 'roles')).toBe(true)
    expect(canViewServerSettingsTab(access, 'overview')).toBe(false)
  })

  it('allows ban managers to open the bans tab without ManageServer', () => {
    const server = makeServer({
      default_permissions: ChannelPermission.BanMembers,
    })
    const member = makeMember()

    const access = getServerSettingsAccess(server, [], member, 'user-1')

    expect(canOpenServerSettings(access)).toBe(true)
    expect(canViewServerSettingsTab(access, 'bans')).toBe(true)
    expect(canViewServerSettingsTab(access, 'audit')).toBe(false)
  })

  it('does not expose invite settings for channel-only invite permission', () => {
    const server = makeServer({
      default_permissions: ChannelPermission.ViewChannel,
    })
    const member = makeMember()
    const inviteChannel = makeTextChannel({
      default_permissions: {
        a: permissionOr(
          ChannelPermission.ViewChannel,
          ChannelPermission.InviteOthers,
        ),
        d: 0,
      },
    })

    const access = getServerSettingsAccess(
      server,
      [inviteChannel],
      member,
      'user-1',
    )

    expect(canOpenServerSettings(access)).toBe(false)
    expect(canViewServerSettingsTab(access, 'invites')).toBe(false)
  })
})
