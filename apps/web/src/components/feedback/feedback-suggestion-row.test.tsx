// @vitest-environment jsdom

import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { FeedbackSuggestionRow } from './feedback-suggestion-row'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/feedback/test">{children}</a>,
}))

vi.mock('#/components/feedback/feedback-vote-button', () => ({
  FeedbackVoteButton: () => <button type="button">Проголосовать</button>,
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '',
}))

vi.mock('#/features/sync/sync-store', () => ({
  useSyncStore: (selector: (state: { users: Record<string, never> }) => unknown) =>
    selector({ users: {} }),
}))

const suggestion: FeedbackSuggestion = {
  _id: 'feedback-1',
  anonymous: false,
  title: 'Идея',
  description: 'Описание идеи',
  category: 'idea',
  moderation_status: 'approved',
  status: 'open',
  vote_count: 3,
  voted: false,
  created_at: '2026-07-15T12:00:00.000Z',
  updated_at: '2026-07-15T12:00:00.000Z',
}

describe('FeedbackSuggestionRow', () => {
  it('shows the vote action only for approved suggestions', () => {
    const { rerender } = render(
      <FeedbackSuggestionRow suggestion={suggestion} token="token" />,
    )

    expect(screen.getByRole('button', { name: 'Проголосовать' })).toBeTruthy()

    rerender(
      <FeedbackSuggestionRow
        suggestion={{ ...suggestion, moderation_status: 'pending' }}
        token="token"
      />,
    )

    expect(screen.queryByRole('button', { name: 'Проголосовать' })).toBeNull()
    expect(screen.getByLabelText('3 голосов')).toBeTruthy()
  })
})
