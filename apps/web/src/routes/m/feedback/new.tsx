import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { FeedbackView } from '#/components/feedback/feedback-view'

export const Route = createFileRoute('/m/feedback/new')({
  component: FeedbackCreatePage,
})

function FeedbackCreatePage() {
  const navigate = useNavigate()
  return (
    <FeedbackView
      initialMode="all"
      createOpen
      onCreateClose={() =>
        void navigate({ to: '/m/feedback', search: { view: 'all' } })
      }
      onCreated={() =>
        void navigate({ to: '/m/feedback', search: { view: 'mine' } })
      }
    />
  )
}
