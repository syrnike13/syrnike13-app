import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { FeedbackView } from '#/components/feedback/feedback-view'

export const Route = createFileRoute('/app/feedback/new')({
  component: FeedbackCreatePage,
})

function FeedbackCreatePage() {
  const navigate = useNavigate()
  return (
    <FeedbackView
      initialMode="all"
      createOpen
      onCreateClose={() =>
        void navigate({ to: '/app/feedback', search: { view: 'all' } })
      }
      onCreated={() =>
        void navigate({ to: '/app/feedback', search: { view: 'mine' } })
      }
    />
  )
}
