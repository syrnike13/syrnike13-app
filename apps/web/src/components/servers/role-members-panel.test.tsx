// @vitest-environment jsdom

import type { Role, Server } from '@syrnike13/api-types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoleMembersPanel } from '#/components/servers/role-members-panel'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'viewer-user', username: 'viewer' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  editServerMember: vi.fn(),
}))

vi.mock('#/components/servers/add-role-members-dialog', () => ({
  AddRoleMembersDialog: () => null,
}))

function server(): Server {
  return {
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-user',
    default_permissions: 0,
    roles: {
      role: role(),
    },
  } as Server
}

function role(): Role {
  return {
    _id: 'role',
    name: 'Kitchen Crew',
    permissions: { a: 0, d: 0 },
    rank: 5,
  } as Role
}

describe('RoleMembersPanel', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.upsertUsers([
      {
        _id: 'viewer-user',
        username: 'viewer',
        discriminator: '0001',
      } as never,
      {
        _id: 'target-user',
        username: 'target',
        display_name: 'Global Name',
        discriminator: '0002',
      } as never,
    ])
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'viewer-user' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
      {
        _id: { server: 'server-1', user: 'target-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['role'],
        nickname: 'Kitchen Wizard',
      } as never,
    ])
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('uses server nicknames in the role member list', () => {
    render(<RoleMembersPanel server={server()} role={role()} />)

    expect(screen.getByText('Kitchen Wizard')).toBeTruthy()
    expect(screen.queryByText('Global Name')).toBeNull()
  })

  it('searches role members by server nickname', () => {
    render(<RoleMembersPanel server={server()} role={role()} />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'wizard' },
    })

    expect(screen.getByText('Kitchen Wizard')).toBeTruthy()
  })
})
