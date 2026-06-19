// @vitest-environment jsdom

import type { SessionInfo } from '@syrnike13/api-types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsSessionsPanel } from '#/components/settings/settings-sessions-panel'

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  fetchSessions: vi.fn(),
  revokeOtherSessions: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode
    open?: boolean
  }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/sessions-api', () => ({
  deleteSession: (...args: Parameters<typeof mocks.deleteSession>) =>
    mocks.deleteSession(...args),
  fetchSessions: (...args: Parameters<typeof mocks.fetchSessions>) =>
    mocks.fetchSessions(...args),
  revokeOtherSessions: (
    ...args: Parameters<typeof mocks.revokeOtherSessions>
  ) => mocks.revokeOtherSessions(...args),
}))

vi.mock('#/lib/session', () => ({
  loadSession: () => ({ _id: '65f0000000-current' }),
}))

const sessions = [
  { _id: '65f0000000-current', name: 'This device' },
  { _id: '65f0000001-laptop', name: 'Laptop' },
  { _id: '65f0000002-phone', name: 'Phone' },
] satisfies SessionInfo[]

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  render(
    <QueryClientProvider client={queryClient}>
      <SettingsSessionsPanel />
    </QueryClientProvider>,
  )
}

describe('SettingsSessionsPanel', () => {
  beforeEach(() => {
    mocks.fetchSessions.mockResolvedValue(sessions)
    mocks.deleteSession.mockResolvedValue(undefined)
    mocks.revokeOtherSessions.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('asks for dialog confirmation before revoking one session', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderPanel()

    expect(await screen.findByText('Laptop')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle('Завершить')[0]!)

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.deleteSession).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Laptop')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Завершить' }))

    await waitFor(() => {
      expect(mocks.deleteSession).toHaveBeenCalledWith(
        'session-token',
        '65f0000001-laptop',
      )
    })
  })

  it('asks for dialog confirmation before revoking all other sessions', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderPanel()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Завершить все' }),
    )

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.revokeOtherSessions).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('2')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Завершить все' }),
    )

    await waitFor(() => {
      expect(mocks.revokeOtherSessions).toHaveBeenCalledWith('session-token')
    })
  })
})
