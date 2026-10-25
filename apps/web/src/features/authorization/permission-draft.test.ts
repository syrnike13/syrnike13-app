import type { Member, Server } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import { serverPermissionDraft } from '#/features/authorization/permission-draft'
import { permissionOr } from '#/lib/permission-bits'
import { ServerPermission } from '#/lib/server-permissions'

function server(roles: Server['roles']): Server {
  return {
    _id: 'server-1',
    owner: 'owner',
    name: 'Server',
    channels: [],
    default_permissions: ServerPermission.SendMessage,
    roles,
  } as Server
}

function member(roles: string[]): Member {
  return {
    _id: { server: 'server-1', user: 'member' },
    joined_at: '2026-10-25T00:00:00Z',
    roles,
  } as Member
}

describe('serverPermissionDraft', () => {
  it('combines role grants and ignores legacy role denies', () => {
    const permissions = serverPermissionDraft(
      server({
        mod: {
          _id: 'mod',
          name: 'Mod',
          rank: 0,
          mentionable: true,
          permissions: { a: ServerPermission.KickMembers, d: ServerPermission.SendMessage },
        },
        helper: {
          _id: 'helper',
          name: 'Helper',
          rank: 1,
          mentionable: true,
          permissions: { a: ServerPermission.PinMessages, d: 0 },
        },
      }),
      member(['mod', 'helper']),
      'member',
    )

    expect(permissions).toBe(
      permissionOr(
        permissionOr(ServerPermission.SendMessage, ServerPermission.KickMembers),
        ServerPermission.PinMessages,
      ),
    )
  })

  it('grants every permission to administrators', () => {
    const permissions = serverPermissionDraft(
      server({
        admin: {
          _id: 'admin',
          name: 'Admin',
          rank: 0,
          mentionable: true,
          permissions: { a: ServerPermission.Administrator, d: 0 },
        },
      }),
      member(['admin']),
      'member',
    )

    expect(permissions).toBe(0x000f_ffff_ffff_ffff)
  })
})
