// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsBansPanel } from '#/components/servers/server-settings-bans-panel'

const mocks = vi.hoisted(() => ({
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
  fetchServerBans: (...args: Parameters<typeof mocks.fetchServerBans>) =>
    mocks.fetchServerBans(...args),
  unbanServerMember: (...args: Parameters<typeof mocks.unbanServerMember>) =>
    mocks.unbanServerMember(...args),
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
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('removes a server ban through the moderation API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText('bad-user')).toBeTruthy()
    expect(screen.getByText('spam')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Разбанить' }))

    await waitFor(() => {
      expect(mocks.unbanServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'user-2',
      )
    })
    expect(window.confirm).toHaveBeenCalledWith('Снять бан с bad-user?')
  })

  it('keeps a ban when removal is not confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithQuery(<ServerSettingsBansPanel serverId="server-1" />)

    expect(await screen.findByText('bad-user')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Разбанить' }))

    expect(mocks.unbanServerMember).not.toHaveBeenCalled()
  })
})
