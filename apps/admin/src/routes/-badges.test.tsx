// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    hydrated: true,
    isLoading: false,
    isPrivileged: true,
    session: { _id: 's1', token: 'token', user_id: 'u1' },
    user: { _id: 'u1', privileged: true },
    logout: vi.fn(),
  }),
}))

vi.mock('#/features/api/admin-api', () => ({
  fetchAdminBadges: vi.fn(async () => []),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

import { BadgesCatalogPage } from '#/features/badges/badges-catalog'

describe('badges admin page', () => {
  it('renders the badge catalog for privileged users', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <BadgesCatalogPage />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Бейджи' })).not.toBeNull()
    expect(screen.getByText('Создать')).not.toBeNull()
  })
})
