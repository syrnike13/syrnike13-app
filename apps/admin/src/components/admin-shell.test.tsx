// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {
    isPrivileged: true,
    logout: vi.fn(),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  Outlet: () => <div data-testid="outlet" />,
}))

import { AdminShell } from './admin-shell'

describe('AdminShell', () => {
  afterEach(cleanup)

  it('renders admin navigation for privileged users', () => {
    mocks.auth.isPrivileged = true
    render(<AdminShell />)
    expect(screen.getByText('Admin')).not.toBeNull()
    expect(screen.getByText('Бейджи')).not.toBeNull()
    expect(screen.getByTestId('outlet')).not.toBeNull()
  })

  it('blocks non-privileged users', () => {
    mocks.auth.isPrivileged = false
    render(<AdminShell />)
    expect(screen.getByText('Нет доступа')).not.toBeNull()
  })
})
