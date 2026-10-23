// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UserProfileRoleList } from './user-profile-role-list'

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: null, user: undefined }),
}))

const user = { _id: 'user-1', username: 'bob', online: true } as User

describe('UserProfileRoleList', () => {
  afterEach(() => {
    cleanup()
  })

  it('collapses extra roles into a +N chip', () => {
    render(
      <UserProfileRoleList
        user={user}
        maxVisible={2}
        roles={[
          { id: 'r1', name: 'Alpha', colour: 'ff0000' },
          { id: 'r2', name: 'Beta', colour: null },
          { id: 'r3', name: 'Gamma', colour: '00ff00' },
          { id: 'r4', name: 'Delta', colour: null },
        ]}
      />,
    )

    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.queryByText('Gamma')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '+2' }))

    expect(screen.getByText('Gamma')).toBeTruthy()
    expect(screen.getByText('Delta')).toBeTruthy()
  })

  it('renders nothing without roles or role-management permission', () => {
    const { container } = render(<UserProfileRoleList user={user} />)
    expect(container.firstChild).toBeNull()
  })
})
