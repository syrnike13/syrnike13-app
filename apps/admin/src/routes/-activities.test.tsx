// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateAdminActivity: vi.fn(async (_token: string, id: string, data: object) => ({
    ...activity(id),
    ...data,
  })),
  rotateAdminActivitySecretEffect: vi.fn(() =>
    Effect.succeed({ client_secret: 'secret-value-123' }),
  ),
  createAdminActivityEffect: vi.fn(),
}))

function activity(id: string) {
  return {
    _id: id,
    name: id === 'chess' ? 'Шахматы' : 'Рисовалка',
    activity_url: `https://${id}.activities.syrnike13.ru`,
    max_participants: 2,
    first_party: id === 'chess',
    origin_url: 'https://upstream.example.com',
    url_mappings: [],
    enabled: id === 'chess',
    has_client_secret: false,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  }
}

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

vi.mock('#/features/api/activities-api', () => ({
  fetchAdminActivities: vi.fn(async () => [activity('chess'), activity('paint')]),
  updateAdminActivity: mocks.updateAdminActivity,
  ACTIVITY_ICON_UPLOAD_TAG: 'icons',
  createAdminActivityEffect: mocks.createAdminActivityEffect,
  deleteAdminActivityEffect: vi.fn(),
  rotateAdminActivitySecretEffect: mocks.rotateAdminActivitySecretEffect,
  updateAdminActivityEffect: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}))

import { AdminDraftProvider } from '#/components/draft-controller-context'
import { ActivitiesCatalogPage } from '#/features/activities/activities-catalog'
import { ActivityEditorPage } from '#/features/activities/activity-editor'
import type { AdminActivityApplication } from '#/features/api/activities-api'

function renderWithQuery(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <AdminDraftProvider>{children}</AdminDraftProvider>
    </QueryClientProvider>,
  )
}

function renderCatalog() {
  renderWithQuery(<ActivitiesCatalogPage />)
}

describe('activities admin page', () => {
  it('lists registered applications', async () => {
    renderCatalog()

    expect(screen.getByRole('heading', { name: 'Активности' })).not.toBeNull()
    expect(await screen.findByText('Шахматы')).not.toBeNull()
    expect(screen.getByText('paint')).not.toBeNull()
    expect(screen.getByText('first-party')).not.toBeNull()
    expect(
      screen.getByText('https://chess.activities.syrnike13.ru').closest('a'),
    ).toHaveAttribute('href', 'https://chess.activities.syrnike13.ru')
  })

  it('toggles an application from the list', async () => {
    renderCatalog()

    const toggle = await screen.findByRole('switch', {
      name: 'Включить «Рисовалка»',
    })
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(mocks.updateAdminActivity).toHaveBeenCalledWith('token', 'paint', {
        enabled: true,
      }),
    )
  })
})

describe('activity editor', () => {
  it('shows a generated client secret once with a copy action', async () => {
    renderWithQuery(
      <ActivityEditorPage
        mode="edit"
        activity={activity('chess') as AdminActivityApplication}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Сгенерировать секрет/ }))

    expect(await screen.findByDisplayValue('secret-value-123')).not.toBeNull()
    expect(screen.getByText('Показывается один раз')).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Скопировать секрет' }),
    ).not.toBeNull()
    expect(mocks.rotateAdminActivitySecretEffect).toHaveBeenCalledWith(
      'token',
      'chess',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Я сохранил' }))
    await waitFor(() =>
      expect(screen.queryByDisplayValue('secret-value-123')).toBeNull(),
    )
    expect(
      screen.getByRole('button', { name: /Перевыпустить секрет/ }),
    ).not.toBeNull()
  })

  it('blocks creation until the form is valid', async () => {
    renderWithQuery(<ActivityEditorPage mode="create" />)

    fireEvent.change(screen.getByPlaceholderText('chess'), {
      target: { value: '-bad' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))

    expect(
      await screen.findByText(/Строчные латинские буквы, цифры и дефисы \(/),
    ).not.toBeNull()
    expect(screen.getAllByText('Обязательное поле').length).toBeGreaterThan(0)
    expect(mocks.createAdminActivityEffect).not.toHaveBeenCalled()
  })
})
