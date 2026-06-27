// @vitest-environment jsdom

import type { Member, Server, User } from '@syrnike13/api-types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { EditMemberRolesDialog } from '#/components/servers/edit-member-roles-dialog'

vi.mock('#/components/servers/member-roles-editor', () => ({
  MemberRolesEditor: () => <div data-testid="member-roles-editor" />,
}))

function server(): Server {
  return {
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-user',
    default_permissions: 0,
  } as Server
}

function member(nickname?: string | null): Member {
  return {
    _id: { server: 'server-1', user: 'target-user' },
    nickname,
  } as Member
}

function user(): User {
  return {
    _id: 'target-user',
    username: 'target',
    display_name: 'Global Name',
    discriminator: '0001',
    relationship: 'None',
    online: false,
  } as User
}

describe('EditMemberRolesDialog', () => {
  it('uses the server nickname in the role dialog title', () => {
    render(
      <EditMemberRolesDialog
        server={server()}
        targetMember={member('Kitchen Wizard')}
        targetUser={user()}
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog').textContent).toContain('Kitchen Wizard')
    expect(screen.queryByText(/Global Name/)).toBeNull()
  })
})
