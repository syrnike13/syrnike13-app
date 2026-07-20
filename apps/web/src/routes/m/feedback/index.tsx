import { createFileRoute } from '@tanstack/react-router'

import {
  FeedbackView,
  type FeedbackViewMode,
} from '#/components/feedback/feedback-view'

function parseView(value: unknown): FeedbackViewMode {
  return value === 'mine' ? 'mine' : 'all'
}

export const Route = createFileRoute('/m/feedback/')({
  validateSearch: (search: Record<string, unknown>) => ({
    view: parseView(search.view),
  }),
  component: FeedbackIndexPage,
})

function FeedbackIndexPage() {
  const { view } = Route.useSearch()
  return <FeedbackView key={view} initialMode={view} />
}
