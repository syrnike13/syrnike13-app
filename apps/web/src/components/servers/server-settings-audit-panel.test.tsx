// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsAuditPanel } from '#/components/servers/server-settings-audit-panel'

const mocks = vi.hoisted(() => ({
  fetchServerAuditLog: vi.fn(),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'actor-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  fetchServerAuditLog: (...args: Parameters<typeof mocks.fetchServerAuditLog>) =>
    mocks.fetchServerAuditLog(...args),
}))

function renderWithQuery(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  )
}

describe('ServerSettingsAuditPanel', () => {
  beforeEach(() => {
    mocks.fetchServerAuditLog.mockResolvedValue({
      entries: [
        {
          _id: 'audit-1',
          server_id: 'server-1',
          actor_id: 'actor-1',
          action: { type: 'RoleCreate' },
          target: { type: 'Role', id: 'role-1' },
          reason: 'setup',
          changes: {},
          status: 'Succeeded',
          created_at: 0,
          completed_at: 1,
        },
      ],
      next_before: null,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders audit entries returned by the API', async () => {
    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    expect(await screen.findByText('RoleCreate')).toBeTruthy()
    expect(screen.getByText('actor-1')).toBeTruthy()
    expect(screen.getByText('role-1')).toBeTruthy()
    expect(screen.getByText('setup')).toBeTruthy()

    await waitFor(() => {
      expect(mocks.fetchServerAuditLog).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        { limit: 50 },
      )
    })
  })

  it('loads the next audit page when a cursor is available', async () => {
    mocks.fetchServerAuditLog
      .mockResolvedValueOnce({
        entries: [
          {
            _id: 'audit-1',
            server_id: 'server-1',
            actor_id: 'actor-1',
            action: { type: 'RoleCreate' },
            target: { type: 'Role', id: 'role-1' },
            reason: null,
            changes: {},
            status: 'Succeeded',
            created_at: 0,
            completed_at: 1,
          },
        ],
        next_before: 'audit-1',
      })
      .mockResolvedValueOnce({
        entries: [
          {
            _id: 'audit-2',
            server_id: 'server-1',
            actor_id: 'actor-2',
            action: { type: 'MemberBan' },
            target: { type: 'Member', user_id: 'user-2' },
            reason: 'spam',
            changes: {},
            status: 'Succeeded',
            created_at: 0,
            completed_at: 1,
          },
        ],
        next_before: null,
      })

    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    expect(await screen.findByText('RoleCreate')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Загрузить ещё' }))

    expect(await screen.findByText('MemberBan')).toBeTruthy()
    expect(mocks.fetchServerAuditLog).toHaveBeenLastCalledWith(
      'session-token',
      'server-1',
      { limit: 50, before: 'audit-1' },
    )
  })
})
