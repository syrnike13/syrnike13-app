import { createFileRoute } from '@tanstack/react-router'

import { FeedbackCreateForm } from '#/components/feedback/feedback-create-form'

export const Route = createFileRoute('/app/feedback/new')({
  component: FeedbackCreateForm,
})
