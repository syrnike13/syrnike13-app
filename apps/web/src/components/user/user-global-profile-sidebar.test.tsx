// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserGlobalProfileSidebar } from '#/components/user/user-global-profile-sidebar'
import { syncStore } from '#/features/sync/sync-store'
import { grantAllAuthorizationForTest } from '#/features/authorization/authorization-test-utils'

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null }),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-current', username: 'alice' },
  }),
}))

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: () => <div data-testid="avatar" />,
}))

vi.mock('#/components/servers/edit-member-roles-dialog', () => ({
  EditMemberRolesDialog: () => null,
}))

describe('UserGlobalProfileSidebar', () => {
  beforeEach(() => {
    syncStore.reset()
    grantAllAuthorizationForTest({ userIds: ['user-target'] })
    syncStore.upsertServer({
      _id: 'server-a',
      name: 'Alpha',
      owner: 'owner',
      channels: [],
      default_permissions: 0,
    } as never)
    syncStore.upsertMembers([
      { _id: { server: 'server-a', user: 'user-target' } },
    ] as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('does not render an invalid join date when member data has no joined_at', () => {
    render(
      <UserGlobalProfileSidebar
        user={{ _id: 'user-target', username: 'bob', online: true } as never}
        serverId="server-a"
        isSelf={false}
        busy={false}
        onOpenDm={vi.fn()}
        onCopyId={vi.fn()}
        onBlock={vi.fn()}
        onUnblock={vi.fn()}
        onEditProfile={vi.fn()}
      />,
    )

    expect(screen.queryByText('Invalid Date')).toBeNull()
    expect(screen.getByRole('button', { name: 'Сообщение' })).toBeTruthy()
  })
})
