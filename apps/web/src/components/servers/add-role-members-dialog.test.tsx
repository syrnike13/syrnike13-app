// @vitest-environment jsdom

import type { Role, Server } from '@syrnike13/api-types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddRoleMembersDialog } from '#/components/servers/add-role-members-dialog'
import { syncStore } from '#/features/sync/sync-store'
import { grantAllAuthorizationForTest } from '#/features/authorization/authorization-test-utils'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'owner-user', username: 'owner' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  editServerMember: vi.fn(),
  fetchServerMembers: vi.fn().mockResolvedValue({ members: [], users: [] }),
}))

function role(): Role {
  return {
    _id: 'role',
    name: 'Kitchen Crew',
    permissions: { a: 0, d: 0 },
    mentionable: false,
    rank: 5,
  } as Role
}

function server(): Server {
  return {
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-user',
    channels: [],
    default_permissions: 0,
    roles: {
      role: role(),
    },
  } as Server
}

describe('AddRoleMembersDialog', () => {
  beforeEach(() => {
    syncStore.reset()
    grantAllAuthorizationForTest({ serverIds: ['server-1'] })
    syncStore.upsertUsers([
      {
        _id: 'owner-user',
        username: 'owner',
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
        _id: { server: 'server-1', user: 'owner-user' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
      {
        _id: { server: 'server-1', user: 'target-user' },
        joined_at: '2024-01-01T00:00:00Z',
        nickname: 'Kitchen Wizard',
      } as never,
    ])
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('uses server nicknames in the candidate list', () => {
    render(
      <AddRoleMembersDialog
        server={server()}
        role={role()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Kitchen Wizard')).toBeTruthy()
    expect(screen.queryByText('Global Name')).toBeNull()
  })

  it('searches candidates by server nickname', () => {
    render(
      <AddRoleMembersDialog
        server={server()}
        role={role()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'wizard' },
    })

    expect(screen.getByText('Kitchen Wizard')).toBeTruthy()
  })
})
