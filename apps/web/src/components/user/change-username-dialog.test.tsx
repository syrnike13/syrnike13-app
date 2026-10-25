// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UsernameResetPrompt } from '#/components/user/change-username-dialog'

const auth = vi.hoisted(() => ({ flags: 0 }))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'kate_1234', flags: auth.flags },
    refreshUser: vi.fn(),
  }),
}))

describe('UsernameResetPrompt', () => {
  afterEach(() => {
    cleanup()
    sessionStorage.clear()
  })

  it('asks renamed users to pick a username', () => {
    auth.flags = 16
    render(<UsernameResetPrompt />)

    expect(screen.getByText('Выберите имя пользователя')).toBeTruthy()
    expect(screen.getByDisplayValue('kate_1234')).toBeTruthy()
  })

  it('stays hidden for everyone else', () => {
    auth.flags = 0
    render(<UsernameResetPrompt />)

    expect(screen.queryByText('Выберите имя пользователя')).toBeNull()
  })
})
