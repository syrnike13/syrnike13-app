import { createFileRoute } from '@tanstack/react-router'

import { FeedbackDetailView } from '#/components/feedback/feedback-detail-view'

export const Route = createFileRoute('/m/feedback/$feedbackId')({
  component: FeedbackDetailPage,
})

function FeedbackDetailPage() {
  const { feedbackId } = Route.useParams()
  return <FeedbackDetailView feedbackId={feedbackId} />
}
