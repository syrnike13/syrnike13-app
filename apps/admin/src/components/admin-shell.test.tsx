// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {
    isPrivileged: true,
    logout: vi.fn(),
    user: { username: 'admin', display_name: 'Admin' },
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('#/lib/config', () => ({
  config: { releaseChannel: 'stable', appVersion: '0.5.1' },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  Outlet: () => <div data-testid="outlet" />,
  useRouterState: () => '/badges',
}))

import { AdminShell } from './admin-shell'

describe('AdminShell', () => {
  afterEach(cleanup)

  it('renders navigation for privileged users', () => {
    mocks.auth.isPrivileged = true
    render(<AdminShell />)
    expect(screen.getByText('syrnike13')).not.toBeNull()
    expect(screen.getByText('Бейджи')).not.toBeNull()
    expect(screen.getByText('Пользователи')).not.toBeNull()
  })

  it('blocks non-privileged users', () => {
    mocks.auth.isPrivileged = false
    render(<AdminShell />)
    expect(screen.getByText('Нет доступа')).not.toBeNull()
  })
})
