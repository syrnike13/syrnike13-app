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
  fetchAdminUser: vi.fn(),
  fetchAdminUserBadges: vi.fn(async () => []),
  createAdminBadge: vi.fn(),
  updateAdminBadge: vi.fn(),
  deleteAdminBadge: vi.fn(),
  assignAdminUserBadge: vi.fn(),
  removeAdminUserBadge: vi.fn(),
}))

vi.mock('#/features/api/media-api', () => ({
  uploadMediaFile: vi.fn(),
}))

import { AdminBadgesPage } from './badges'

describe('badges admin page', () => {
  it('renders the badge admin page for privileged users', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <AdminBadgesPage />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Бейджи' })).not.toBeNull()
  })
})
