// @vitest-environment jsdom

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
import type { Badge } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminBadgesPage } from '#/routes/admin/-badges-page'

const adminApiMocks = vi.hoisted(() => ({
  assignAdminUserBadge: vi.fn(),
  createAdminBadge: vi.fn(),
  deleteAdminBadge: vi.fn().mockResolvedValue(undefined),
  fetchAdminBadges: vi.fn(),
  fetchAdminUser: vi.fn(),
  fetchAdminUserBadges: vi.fn(),
  removeAdminUserBadge: vi.fn(),
  updateAdminBadge: vi.fn(),
}))

const badge = {
  _id: 'badge-1',
  slug: 'founder',
  name: 'Founder',
  description: 'Early supporter',
  visible: true,
  premium: false,
  display_order: 10,
  icon: null,
} as Badge

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'admin-token' },
    user: { _id: 'admin-user', username: 'admin' },
  }),
}))

vi.mock('#/features/api/admin-api', () => adminApiMocks)

vi.mock('#/features/api/media-api', () => ({
  uploadMediaFile: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
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
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}))

function renderAdminBadgesPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <AdminBadgesPage />
    </QueryClientProvider>,
  )
}

describe('AdminBadgesPage', () => {
  beforeEach(() => {
    adminApiMocks.deleteAdminBadge.mockClear()
    adminApiMocks.fetchAdminBadges.mockResolvedValue([badge])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('confirms deleting a badge in an app dialog before calling the delete API', async () => {
    const confirmMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmMock)

    renderAdminBadgesPage()

    fireEvent.click(await screen.findByRole('button', { name: /Founder/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    expect(confirmMock).not.toHaveBeenCalled()
    expect(adminApiMocks.deleteAdminBadge).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Удалить бейдж «Founder»?')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }))

    await waitFor(() => {
      expect(adminApiMocks.deleteAdminBadge).toHaveBeenCalledWith(
        'admin-token',
        'badge-1',
      )
    })
  })
})
