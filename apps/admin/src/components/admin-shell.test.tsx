// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {
    isPrivileged: true,
    logout: vi.fn(),
    user: { username: 'admin', display_name: 'Admin' },
  },
  blockerOptions: undefined as
    | {
        shouldBlockFn: () => boolean
        enableBeforeUnload: () => boolean
      }
    | undefined,
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
  useBlocker: (options: NonNullable<typeof mocks.blockerOptions>) => {
    mocks.blockerOptions = options
  },
  useRouterState: () => '/badges',
}))

import { AdminShell } from './admin-shell'
import { useAdminDraftRegistration } from './draft-controller-context'

function DirtyDraft() {
  useAdminDraftRegistration({
    isDirty: true,
    isSaving: false,
    save: async () => true,
    reset: () => true,
  })
  return <div>Черновик</div>
}

describe('AdminShell', () => {
  afterEach(() => {
    cleanup()
    mocks.blockerOptions = undefined
  })

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

  it('blocks shell navigation and browser unload for a dirty draft', async () => {
    mocks.auth.isPrivileged = true
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(
      <AdminShell>
        <DirtyDraft />
      </AdminShell>,
    )

    await waitFor(() => {
      expect(mocks.blockerOptions?.enableBeforeUnload()).toBe(true)
    })
    expect(mocks.blockerOptions?.shouldBlockFn()).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()

    confirm.mockRestore()
  })
})
