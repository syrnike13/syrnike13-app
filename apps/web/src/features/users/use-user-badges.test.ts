// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { useUserBadges } from './use-user-badges'

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: { token: 'token' } }),
}))

const fetchUser = vi.fn()

vi.mock('#/features/api/users-api', () => ({
  fetchUser: (...args: unknown[]) => fetchUser(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

describe('useUserBadges', () => {
  it('returns fallback badges without fetching', () => {
    const fallback = [
      {
        _id: 'badge-1',
        slug: 'founder',
        name: 'Основатель',
        icon: { _id: 'file-1', tag: 'badges' },
        order: 0,
      },
    ] as never

    const { result } = renderHook(
      () => useUserBadges('user-1', fallback),
      { wrapper },
    )

    expect(result.current).toBe(fallback)
    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('loads badges from REST when sync user has none', async () => {
    fetchUser.mockResolvedValueOnce({
      _id: 'user-1',
      badges: [
        {
          _id: 'badge-1',
          slug: 'developer',
          name: 'Разработчик',
          icon: { _id: 'file-2', tag: 'badges' },
          order: 10,
        },
      ],
    })

    const { result } = renderHook(() => useUserBadges('user-1'), { wrapper })

    await waitFor(() => {
      expect(result.current).toHaveLength(1)
    })
    expect(fetchUser).toHaveBeenCalledWith('token', 'user-1')
    expect(result.current?.[0]?.slug).toBe('developer')
  })
})
