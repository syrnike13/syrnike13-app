// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
  blocker: {
    status: 'idle' as 'idle' | 'blocked',
    proceed: vi.fn(),
    reset: vi.fn(),
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
  useBlocker: (options: NonNullable<typeof mocks.blockerOptions>) => {
    mocks.blockerOptions = options
    return mocks.blocker
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
    mocks.blocker.status = 'idle'
    mocks.blocker.proceed.mockClear()
    mocks.blocker.reset.mockClear()
    mocks.auth.logout.mockClear()
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
    const confirm = vi.spyOn(window, 'confirm')

    render(
      <AdminShell>
        <DirtyDraft />
      </AdminShell>,
    )

    await waitFor(() => {
      expect(mocks.blockerOptions?.enableBeforeUnload()).toBe(true)
    })
    expect(mocks.blockerOptions?.shouldBlockFn()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()

    confirm.mockRestore()
  })

  it('asks before leaving through a blocked navigation', async () => {
    mocks.auth.isPrivileged = true
    mocks.blocker.status = 'blocked'

    render(<AdminShell />)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Несохранённые изменения')).not.toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Остаться' }))
    expect(mocks.blocker.reset).toHaveBeenCalledOnce()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Покинуть' }))
    expect(mocks.blocker.proceed).toHaveBeenCalledOnce()
  })

  it('asks before signing out with a dirty draft', async () => {
    mocks.auth.isPrivileged = true

    render(
      <AdminShell>
        <DirtyDraft />
      </AdminShell>,
    )

    await waitFor(() => {
      expect(mocks.blockerOptions?.shouldBlockFn()).toBe(true)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Выйти?')).not.toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Выйти' }))

    await waitFor(() => {
      expect(mocks.auth.logout).toHaveBeenCalledOnce()
    })
  })
})
