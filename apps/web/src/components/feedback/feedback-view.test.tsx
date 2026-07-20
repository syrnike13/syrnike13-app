// @vitest-environment jsdom

import type { FeedbackSuggestionPage } from '@syrnike13/api-types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FeedbackView, type FeedbackViewMode } from './feedback-view'

const emptyPage: FeedbackSuggestionPage = {
  suggestions: [],
  total: 0,
  offset: 0,
  limit: 20,
}

const mocks = vi.hoisted(() => ({
  fetchFeedbackSuggestions: vi.fn(),
  fetchMyFeedbackSuggestions: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/feedback">{children}</a>,
}))

vi.mock('#/components/feedback/feedback-suggestion-row', () => ({
  FeedbackSuggestionRow: () => <article>Обращение</article>,
}))

vi.mock('#/features/api/feedback-api', () => ({
  fetchFeedbackSuggestions: (
    ...args: Parameters<typeof mocks.fetchFeedbackSuggestions>
  ) => mocks.fetchFeedbackSuggestions(...args),
  fetchMyFeedbackSuggestions: (
    ...args: Parameters<typeof mocks.fetchMyFeedbackSuggestions>
  ) => mocks.fetchMyFeedbackSuggestions(...args),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'token' },
    user: { _id: 'user-1' },
  }),
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '',
}))

function renderFeedbackView(initialMode: FeedbackViewMode = 'all') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackView initialMode={initialMode} />
    </QueryClientProvider>,
  )
}

describe('FeedbackView', () => {
  beforeEach(() => {
    mocks.fetchFeedbackSuggestions.mockReset()
    mocks.fetchMyFeedbackSuggestions.mockReset()
    mocks.fetchFeedbackSuggestions.mockResolvedValue(emptyPage)
    mocks.fetchMyFeedbackSuggestions.mockResolvedValue(emptyPage)
  })

  afterEach(cleanup)

  it('hides unsupported catalogue controls when showing own feedback', async () => {
    renderFeedbackView()

    expect(screen.getByPlaceholderText('Найти обращение')).not.toBeNull()
    expect(screen.getByLabelText('Сортировка')).not.toBeNull()
    expect(screen.getByLabelText('Тип обращения')).not.toBeNull()
    expect(screen.getByLabelText('Область')).not.toBeNull()
    expect(screen.getByLabelText('Платформа')).not.toBeNull()
    expect(screen.getByLabelText('Статус')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Мои обращения' }))

    expect(screen.queryByPlaceholderText('Найти обращение')).toBeNull()
    expect(screen.queryByLabelText('Сортировка')).toBeNull()
    expect(screen.queryByLabelText('Тип обращения')).toBeNull()
    expect(screen.queryByLabelText('Область')).toBeNull()
    expect(screen.queryByLabelText('Платформа')).toBeNull()
    expect(screen.queryByLabelText('Статус')).toBeNull()

    await waitFor(() => {
      expect(mocks.fetchMyFeedbackSuggestions).toHaveBeenCalledWith('token', {
        offset: 0,
        limit: 20,
      })
    })
  })
})
