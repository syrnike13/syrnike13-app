// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from './auth-context'

vi.mock('./auth-api', () => ({
  fetchCurrentUser: vi.fn(async () => ({ _id: 'u1', privileged: true })),
  loginWithCredentials: vi.fn(),
  loginWithMfa: vi.fn(),
  logoutSession: vi.fn(),
  isLoginSuccess: (value: { result: string }) => value.result === 'Success',
  isLoginMfa: (value: { result: string }) => value.result === 'MFA',
}))

function Probe() {
  const auth = useAuth()
  return <div>{auth.isPrivileged ? 'privileged' : 'not privileged'}</div>
}

describe('admin AuthProvider', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('hydrates from the admin session key and exposes privileged state', async () => {
    localStorage.setItem(
      'syrnike13:admin:session',
      JSON.stringify({ _id: 's1', token: 't1', user_id: 'u1' }),
    )

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('privileged')).not.toBeNull()
    })
  })
})
