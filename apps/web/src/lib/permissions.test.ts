import { describe, expect, it } from 'vitest'

import {
  ChannelPermission,
  calculateServerPermissions,
  getServerMenuPermissions,
  hasChannelPermission,
} from '#/lib/permissions'
import type { Member, Server } from '@syrnike13/api-types'

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
