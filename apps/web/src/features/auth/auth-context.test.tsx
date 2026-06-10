// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { ApiError } from '#/lib/api/client'

import { AuthProvider, useAuth } from './auth-context'
import { fetchCurrentUser } from './auth-api'
import { fetchOnboardHello } from '#/features/api/onboard-api'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('./auth-api', async () => {
  const actual = await vi.importActual<typeof import('./auth-api')>('./auth-api')
  return {
    ...actual,
    fetchCurrentUser: vi.fn(),
  }
})

vi.mock('#/features/api/onboard-api', async () => {
  const actual = await vi.importActual<typeof import('#/features/api/onboard-api')>(
    '#/features/api/onboard-api',
  )
  return {
    ...actual,
    fetchOnboardHello: vi.fn(),
  }
})

const storedSession = {
  _id: 'session-1',
  token: 'token-1',
  user_id: 'user-1',
}

function renderAuth(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>,
  )
}

function AuthProbe() {
  const auth = useAuth()

  return (
    <output data-testid="auth-state">
      {JSON.stringify({
        isLoading: auth.isLoading,
        profileLoadError: auth.profileLoadError?.message ?? null,
        session: auth.session?._id ?? null,
      })}
    </output>
  )
}

describe('AuthProvider profile loading', () => {
  beforeEach(() => {
    localStorage.setItem('syrnike13:session', JSON.stringify(storedSession))
    vi.mocked(fetchOnboardHello).mockResolvedValue({ onboarding: false })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('keeps the session and exposes a terminal profile load error', async () => {
    vi.mocked(fetchCurrentUser).mockRejectedValue(new ApiError('Internal', 500))

    renderAuth(<AuthProbe />)

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('auth-state').textContent ?? '')
      expect(state).toEqual({
        isLoading: false,
        profileLoadError: 'Internal',
        session: 'session-1',
      })
    })
  })
})
