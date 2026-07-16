// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsBansPanel } from '#/components/servers/server-settings-bans-panel'

const mocks = vi.hoisted(() => ({
  banServerMember: vi.fn(),
  fetchServerBans: vi.fn(),
  unbanServerMember: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  banServerMember: (...args: Parameters<typeof mocks.banServerMember>) =>
    mocks.banServerMember(...args),
  fetchServerBans: (...args: Parameters<typeof mocks.fetchServerBans>) =>
    mocks.fetchServerBans(...args),
  unbanServerMember: (...args: Parameters<typeof mocks.unbanServerMember>) =>
    mocks.unbanServerMember(...args),
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
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

describe('ServerSettingsBansPanel', () => {
  beforeEach(() => {
    mocks.fetchServerBans.mockResolvedValue({
      users: [
        {
          _id: 'user-2',
          username: 'bad-user',
          discriminator: '0001',
          avatar: null,
        },
      ],
      bans: [
        {
          _id: { server: 'server-1', user: 'user-2' },
          reason: 'spam',
        },
      ],
    })
    mocks.unbanServerMember.mockResolvedValue(undefined)
    mocks.banServerMember.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('removes a server ban with an audit reason through a dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText('bad-user')).toBeTruthy()
    expect(screen.getByText('spam')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Разбанить' }))
    fireEvent.change(screen.getByLabelText('Причина снятия бана'), {
      target: { value: 'appeal approved' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Снять бан' }))

    await waitFor(() => {
      expect(mocks.unbanServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'user-2',
        { reason: 'appeal approved' },
      )
    })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('keeps a ban when the removal dialog is cancelled', async () => {
    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText('bad-user')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Разбанить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

    expect(mocks.unbanServerMember).not.toHaveBeenCalled()
  })

  it('does not expose manual ban creation from server settings', async () => {
    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText('bad-user')).toBeTruthy()

    expect(screen.queryByLabelText('ID пользователя для бана')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Забанить пользователя' }),
    ).toBeNull()
    expect(mocks.banServerMember).not.toHaveBeenCalled()
  })

  it('shows the total ban count', async () => {
    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText(/1 забанен/)).toBeTruthy()
  })

  it('filters server bans by user, id, and reason', async () => {
    mocks.fetchServerBans.mockResolvedValue({
      users: [
        {
          _id: 'user-2',
          username: 'bad-user',
          discriminator: '0001',
          avatar: null,
        },
        {
          _id: 'user-3',
          username: 'raid-helper',
          discriminator: '0002',
          avatar: null,
        },
      ],
      bans: [
        {
          _id: { server: 'server-1', user: 'user-2' },
          reason: 'spam',
        },
        {
          _id: { server: 'server-1', user: 'user-3' },
          reason: 'raid cleanup',
        },
      ],
    })

    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText('bad-user')).toBeTruthy()
    expect(screen.getByText('raid-helper')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Поиск банов…'), {
      target: { value: 'raid' },
    })

    expect(screen.queryByText('bad-user')).toBeNull()
    expect(screen.getByText('raid-helper')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Поиск банов…'), {
      target: { value: 'user-2' },
    })

    expect(screen.getByText('bad-user')).toBeTruthy()
    expect(screen.queryByText('raid-helper')).toBeNull()
  })
})
