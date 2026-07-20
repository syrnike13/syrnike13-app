// @vitest-environment jsdom

import type { FeedbackSuggestion, FeedbackSuggestionPage } from '@syrnike13/api-types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminDraftProvider } from '#/components/draft-controller-context'

const firstSuggestion = feedbackSuggestion({
  _id: 'idea-1',
  title: 'Первая идея',
  team_response: 'Первый ответ',
})
const secondSuggestion = feedbackSuggestion({
  _id: 'idea-2',
  title: 'Вторая идея',
  team_response: 'Второй ответ',
})

const emptyPage: FeedbackSuggestionPage = {
  suggestions: [],
  total: 0,
  offset: 0,
  limit: 50,
}
const publishedPage: FeedbackSuggestionPage = {
  suggestions: [firstSuggestion, secondSuggestion],
  total: 2,
  offset: 0,
  limit: 50,
}

const mocks = vi.hoisted(() => ({
  fetchPendingFeedback: vi.fn(),
  fetchPublishedFeedback: vi.fn(),
  fetchAllPublishedFeedback: vi.fn(),
  approveFeedback: vi.fn(),
  rejectFeedback: vi.fn(),
  mergeFeedback: vi.fn(),
  hideFeedback: vi.fn(),
  updateFeedback: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: Parameters<typeof mocks.toastSuccess>) =>
      mocks.toastSuccess(...args),
    error: (...args: Parameters<typeof mocks.toastError>) =>
      mocks.toastError(...args),
    warning: (...args: Parameters<typeof mocks.toastWarning>) =>
      mocks.toastWarning(...args),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: { token: 'token' } }),
}))

vi.mock('#/features/api/feedback-api', () => ({
  fetchPendingFeedback: (
    ...args: Parameters<typeof mocks.fetchPendingFeedback>
  ) => mocks.fetchPendingFeedback(...args),
  fetchPublishedFeedback: (
    ...args: Parameters<typeof mocks.fetchPublishedFeedback>
  ) => mocks.fetchPublishedFeedback(...args),
  fetchAllPublishedFeedback: (
    ...args: Parameters<typeof mocks.fetchAllPublishedFeedback>
  ) => mocks.fetchAllPublishedFeedback(...args),
  approveFeedback: (...args: Parameters<typeof mocks.approveFeedback>) =>
    mocks.approveFeedback(...args),
  rejectFeedback: (...args: Parameters<typeof mocks.rejectFeedback>) =>
    mocks.rejectFeedback(...args),
  mergeFeedback: (...args: Parameters<typeof mocks.mergeFeedback>) =>
    mocks.mergeFeedback(...args),
  hideFeedback: (...args: Parameters<typeof mocks.hideFeedback>) =>
    mocks.hideFeedback(...args),
  updateFeedback: (...args: Parameters<typeof mocks.updateFeedback>) =>
    mocks.updateFeedback(...args),
}))

import { FeedbackModerationPage } from './feedback-moderation'

function feedbackSuggestion(
  overrides: Partial<FeedbackSuggestion> = {},
): FeedbackSuggestion {
  return {
    _id: 'idea',
    anonymous: false,
    title: 'Идея',
    description: 'Описание идеи',
    category: 'idea',
    area: 'navigation',
    platform: 'web',
    moderation_status: 'approved',
    status: 'planned',
    team_response: null,
    vote_count: 3,
    voted: false,
    created_at: '2026-07-15T12:00:00.000Z',
    updated_at: '2026-07-15T12:00:00.000Z',
    ...overrides,
  }
}

function renderFeedbackModerationPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AdminDraftProvider>
        <FeedbackModerationPage />
      </AdminDraftProvider>
    </QueryClientProvider>,
  )
}

async function openPublishedFeedback() {
  renderFeedbackModerationPage()
  fireEvent.click(await screen.findByRole('tab', { name: /Опубликованные/ }))
  await screen.findByRole('heading', { name: firstSuggestion.title })
}

describe('FeedbackModerationPage', () => {
  beforeEach(() => {
    mocks.fetchPendingFeedback.mockResolvedValue(emptyPage)
    mocks.fetchPublishedFeedback.mockResolvedValue(publishedPage)
    mocks.fetchAllPublishedFeedback.mockResolvedValue([
      firstSuggestion,
      secondSuggestion,
    ])
    mocks.updateFeedback.mockImplementation(async (_token, id, data) => ({
      ...(id === firstSuggestion._id ? firstSuggestion : secondSuggestion),
      status: data.status,
      team_response: data.response,
      updated_at: '2026-07-15T12:01:00.000Z',
    }))
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps a dirty published editor mounted until reset or save', async () => {
    await openPublishedFeedback()

    const response = screen.getByLabelText('Ответ команды') as HTMLTextAreaElement
    expect(response.value).toBe(firstSuggestion.team_response)
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()

    fireEvent.change(response, { target: { value: 'Черновик ответа' } })

    expect(screen.getByRole('button', { name: 'Сохранить' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Сбросить' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Вторая идея/ }))

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Сохраните или сбросьте изменения перед сменой обращения',
    )
    expect(screen.getByRole('heading', { name: firstSuggestion.title })).not.toBeNull()
    expect((screen.getByLabelText('Ответ команды') as HTMLTextAreaElement).value).toBe(
      'Черновик ответа',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }))

    expect((screen.getByLabelText('Ответ команды') as HTMLTextAreaElement).value).toBe(
      firstSuggestion.team_response,
    )
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Вторая идея/ }))

    await screen.findByRole('heading', { name: secondSuggestion.title })
  })

  it('saves the published response through one update call', async () => {
    await openPublishedFeedback()

    fireEvent.change(screen.getByLabelText('Ответ команды'), {
      target: { value: 'Новый официальный ответ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.updateFeedback).toHaveBeenCalledTimes(1)
    })
    expect(mocks.updateFeedback).toHaveBeenCalledWith('token', 'idea-1', {
      expected_updated_at: firstSuggestion.updated_at,
      status: 'planned',
      response: 'Новый официальный ответ',
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
    })
  })
})
